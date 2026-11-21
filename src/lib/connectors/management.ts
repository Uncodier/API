import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, getConnectorPolicy, getMemberGrant, getVisibleConnector, loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { catalogToolId, validateCatalogToolIds } from './composio-tool-metadata';
import { createComposioClient } from './composio-transport';
import { compatibleReviewedTools } from './reviewed-tools';
import { ConnectorError, connectorAccessMode, connectorToolAccessMode, isGrantCurrent, type ConnectorAgentGrant, type ConnectorMemberGrant } from './types';
import { effectiveMemberGrant } from './grant-resolution';
import { supportPublicationSchema } from './support-policy';

const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true }).nullable().optional();
const member = z.object({
  user_id: uuid, can_view: z.boolean(), can_use: z.boolean(), expires_at: instant,
  revoked_at: instant.refine(value => !value || Date.parse(value) <= Date.now()),
}).strict().refine(value => !value.can_use || value.can_view);
const agent = z.object({
  agent_id: uuid, enabled: z.boolean(), expires_at: instant,
  revoked_at: instant.refine(value => !value || Date.parse(value) <= Date.now()),
}).strict();
const revision = z.object({ site_id: uuid, expected_revision: z.number().int().min(1).max(2_147_483_646) }).strict();
export const accessPatchSchema = revision.extend({ members: z.array(member).max(100), agents: z.array(agent).max(100) }).strict()
  .refine(value => value.members.length + value.agents.length > 0)
  .refine(value => new Set(value.members.map(row => row.user_id)).size === value.members.length)
  .refine(value => new Set(value.agents.map(row => row.agent_id)).size === value.agents.length);
const fullPolicy = revision.extend({
  catalog_reads: z.boolean().optional(),
  support_publication: supportPublicationSchema.nullish(),
  tool_access_mode: z.enum(['all', 'selected']).default('selected'),
  allowed_tools: z.array(catalogToolId).max(100),
  allowed_hosts: z.array(z.enum(['assistant', 'direct'])).max(2),
  require_approval: z.boolean(), enabled: z.boolean(),
}).strict().refine(value => new Set(value.allowed_tools).size === value.allowed_tools.length
  && new Set(value.allowed_hosts).size === value.allowed_hosts.length);
const catalogOptOut = revision.extend({ catalog_reads: z.literal(false) }).strict();
export const policyPatchSchema = z.union([catalogOptOut, fullPolicy]);
const resultSchema = z.object({ connector_id: uuid, revision: z.number().int().positive() });
const optionSchema = z.object({ id: uuid, label: z.string().min(1).max(500) }).strict();
const optionsSchema = z.object({ member_options: z.array(optionSchema).max(1000), agent_options: z.array(optionSchema).max(1000) }).strict();

export async function connectorMutation(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(name, args).abortSignal(AbortSignal.timeout(5_000));
  if (error) connectorDatabaseError(error);
  const parsed = resultSchema.safeParse(data);
  if (!parsed.success || parsed.data.connector_id !== args.p_connector_id
    || parsed.data.revision !== Number(args.p_expected_revision) + 1) {
    throw new ConnectorError('STORAGE_UNAVAILABLE', 'The connector change could not be confirmed. Reload before retrying.', 503);
  }
  return parsed.data;
}

function memberProjection(row: ConnectorMemberGrant) {
  const can_view = row.can_view && isGrantCurrent(row);
  return { user_id: row.user_id, can_view, can_use: row.can_use && can_view, expires_at: row.expires_at, revoked_at: row.revoked_at ?? null };
}
function agentProjection(row: ConnectorAgentGrant) {
  return { agent_id: row.agent_id, enabled: row.enabled && isGrantCurrent(row), expires_at: row.expires_at, revoked_at: row.revoked_at ?? null };
}

export async function getConnectorAccess(siteId: string, userId: string, connectorId: string) {
  uuid.parse(siteId); uuid.parse(connectorId);
  const access = await requireConnectorSiteAccess(siteId, userId);
  const connector = await getVisibleConnector(siteId, userId, connectorId);
  const access_mode = connectorAccessMode(connector);
  const policy = await getConnectorPolicy(siteId, connectorId);
  const tool_access_mode = connectorToolAccessMode(policy.tool_access_mode);
  if (!access.can_manage) {
    const own = await getMemberGrant(siteId, userId, connectorId);
    const effective = effectiveMemberGrant(connector, own);
    if (!effective.can_view) throw new ConnectorError('NOT_FOUND', 'Connector not found.', 404);
    const allowed = effective.can_use && connector.enabled && !connector.revocation_pending && connector.provider_status === 'ACTIVE';
    return {
      connector_id: connectorId, revision: connector.revision, access_mode,
      members: own ? [memberProjection(own)] : [], agents: [],
      // Effective human ceiling only. No other user's/agent's grants or selection options.
      policy: {
        catalog_reads: allowed && !!connector.verified_at && !connector.revocation_dispatched && policy.allowed_hosts.includes('assistant') && policy.catalog_reads === true,
        tool_access_mode: allowed ? tool_access_mode : 'selected' as const,
        allowed_tools: allowed && tool_access_mode === 'selected' ? policy.allowed_tools : [],
        allowed_hosts: allowed ? policy.allowed_hosts : [], require_approval: policy.require_approval,
      },
      member_options: [], agent_options: [], reviewed_tools: [], can_manage: false,
    };
  }
  const [members, agents, options] = await Promise.all([
    supabaseAdmin.from('connector_members').select('user_id,can_view,can_use,expires_at,revoked_at', { count: 'exact' })
      .eq('site_id', siteId).eq('connector_id', connectorId).limit(1000).abortSignal(AbortSignal.timeout(5_000)),
    supabaseAdmin.from('connector_agents').select('agent_id,enabled,expires_at,revoked_at', { count: 'exact' })
      .eq('site_id', siteId).eq('connector_id', connectorId).limit(1000).abortSignal(AbortSignal.timeout(5_000)),
    supabaseAdmin.rpc('connector_access_options', { p_site_id: siteId, p_actor_id: userId }).abortSignal(AbortSignal.timeout(5_000)),
  ]);
  for (const result of [members, agents, options]) if (result.error) connectorDatabaseError(result.error);
  if ((members.count ?? 0) > 1000 || (agents.count ?? 0) > 1000) {
    throw new ConnectorError('ACCESS_LIMIT', 'Too many connector grants for this request.', 422);
  }
  if (!Array.isArray(members.data) || !Array.isArray(agents.data)
    || members.count !== members.data.length || agents.count !== agents.data.length) connectorDatabaseError(null);
  const parsed = optionsSchema.safeParse(options.data);
  if (!parsed.success) throw new ConnectorError('STORAGE_UNAVAILABLE', 'Connector access options are unavailable.', 503);
  return {
    connector_id: connectorId, revision: connector.revision, access_mode,
    members: (members.data as ConnectorMemberGrant[]).map(memberProjection),
    agents: (agents.data as ConnectorAgentGrant[]).map(agentProjection),
    policy: { tool_access_mode, catalog_reads: policy.catalog_reads === true, allowed_tools: policy.allowed_tools, allowed_hosts: policy.allowed_hosts,
      require_approval: policy.require_approval, support_publication: policy.support_publication ?? null },
    ...parsed.data, can_manage: true,
    reviewed_tools: compatibleReviewedTools(connector)
      .map(tool => ({ slug: tool.slug, description: tool.description })),
  };
}

export async function updateConnectorAccess(userId: string, connectorId: string, input: z.infer<typeof accessPatchSchema>) {
  const body = accessPatchSchema.parse(input); uuid.parse(connectorId);
  await requireConnectorSiteAccess(body.site_id, userId, true);
  await getVisibleConnector(body.site_id, userId, connectorId);
  // Named rows only; the RPC checks each same-site target and preserves unrelated grants.
  return connectorMutation('connector_update_access', {
    p_site_id: body.site_id, p_connector_id: connectorId, p_actor_id: userId,
    p_expected_revision: body.expected_revision, p_members: body.members, p_agents: body.agents,
  });
}

export async function updateConnectorPolicy(userId: string, connectorId: string, input: z.input<typeof policyPatchSchema>) {
  const body = policyPatchSchema.parse(input); uuid.parse(connectorId);
  await requireConnectorSiteAccess(body.site_id, userId, true);
  const connector = await getVisibleConnector(body.site_id, userId, connectorId);
  const scope = { p_site_id: body.site_id, p_connector_id: connectorId, p_actor_id: userId, p_expected_revision: body.expected_revision };
  if (!('allowed_tools' in body)) return connectorMutation('connector_disable_catalog_reads', scope);
  if (body.catalog_reads !== false && body.support_publication && connector.toolkit_slug !== 'gmail') {
    throw new ConnectorError('INVALID_PUBLICATION', 'Only Gmail supports published support titles.', 400);
  }
  // The full-body false overload compares every other field under the revision lock.
  // Skipping the remote catalog check there can only turn this single flag off.
  if (body.catalog_reads !== false && body.allowed_tools.length) {
    const { apiKey } = await loadConnectorCredential(body.site_id);
    await validateCatalogToolIds(createComposioClient(apiKey), connector.toolkit_slug, body.allowed_tools);
  }
  return connectorMutation('connector_update_policy', {
    ...scope, p_tool_access_mode: body.tool_access_mode, p_allowed_tools: body.allowed_tools,
    p_allowed_hosts: body.allowed_hosts, p_require_approval: body.require_approval, p_enabled: body.enabled,
    p_support_publication: body.support_publication ?? null,
    ...(body.catalog_reads === undefined ? {} : { p_catalog_reads: body.catalog_reads }),
  });
}