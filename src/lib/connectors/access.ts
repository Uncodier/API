import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createHash } from 'node:crypto';
import { decryptToken } from '@/lib/utils/token-decryption';
import {
  CONNECTOR_COLUMNS, PROVIDER_COLUMNS, ConnectorError, connectorToolAccessMode, isGrantCurrent,
  type AuthorizedConnector, type Connector, type ConnectorContext,
  type ConnectorMemberGrant, type ConnectorPolicy, type ConnectorProvider,
} from './types';
import { policyReviewedTools, REVIEWED_CONNECTOR_TOOLS } from './reviewed-tools';
import { effectiveAgentGrant, effectiveMemberGrant } from './grant-resolution';

const uuid = z.string().uuid();
const deadline = () => AbortSignal.timeout(5_000);

export function connectorDatabaseError(error: unknown): never {
  const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
  if (code === 'P0C01') throw new ConnectorError('CATALOG_OPT_OUT_SEPARATE', 'Save the catalogue opt-out separately from other policy changes.', 409);
  if (code === '40001') throw new ConnectorError('REVISION_CONFLICT', 'Configuration changed. Reload before trying again.', 409);
  if (code === '42501') throw new ConnectorError('ACCESS_DENIED', 'Connector access denied.', 403);
  if (code === '23503' || code === '23514' || code === '22023') {
    throw new ConnectorError('INVALID_REFERENCE', 'The selected connector access references are not valid.', 400);
  }
  throw new ConnectorError('STORAGE_UNAVAILABLE', 'Connector storage is unavailable. Check migration readiness.', 503);
}

/** The database rechecks license, membership, screen and site-wide location access. */
export async function requireConnectorSiteAccess(siteId: string, userId: string, manager = false) {
  uuid.parse(siteId); uuid.parse(userId);
  const { data, error } = await supabaseAdmin.rpc('connector_site_access', {
    p_site_id: siteId, p_user_id: userId,
  }).abortSignal(deadline());
  if (error) connectorDatabaseError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.can_view !== true || (manager && row.can_manage !== true)) {
    throw new ConnectorError('ACCESS_DENIED', 'Connector access denied.', 403);
  }
  return { can_view: true as const, can_manage: row.can_manage === true };
}

export async function listVisibleConnectors(siteId: string, userId: string): Promise<Connector[]> {
  await requireConnectorSiteAccess(siteId, userId);
  // Filter inside SQL before applying the result cap, using the shared RLS visibility rules.
  const { data, error, count } = await supabaseAdmin.rpc('connector_list_visible', {
    p_site_id: siteId, p_user_id: userId,
  }, { count: 'exact' }).select(CONNECTOR_COLUMNS).order('display_name').limit(1000).abortSignal(deadline());
  if (error) connectorDatabaseError(error);
  if ((count ?? 0) > 1000) throw new ConnectorError('CATALOG_LIMIT', 'Too many connectors for this request.', 422);
  if (!Array.isArray(data) || count !== data.length) connectorDatabaseError(null);
  return data as Connector[];
}

export async function getVisibleConnector(siteId: string, userId: string, id: string): Promise<Connector> {
  uuid.parse(id);
  await requireConnectorSiteAccess(siteId, userId);
  const { data, error } = await supabaseAdmin.rpc('connector_list_visible', {
    p_site_id: siteId, p_user_id: userId, p_connector_id: id,
  }).select(CONNECTOR_COLUMNS).abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  if (!data) throw new ConnectorError('NOT_FOUND', 'Connector not found.', 404);
  const connector = data as Connector;
  if (connector.id !== id || connector.site_id !== siteId) connectorDatabaseError(null);
  return connector;
}

export async function loadConnectorCredential(siteId: string): Promise<{ apiKey: string; revision: string; source: 'byok' | 'platform' }> {
  uuid.parse(siteId);
  const { data, error } = await supabaseAdmin.from('site_secrets').select('encrypted_value')
    .eq('site_id', siteId).eq('provider', 'composio').eq('use_case', 'integrations')
    .is('instance_id', null).abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  // Only an absent BYOK row permits the platform credential. Database/decryption
  // errors must never silently move a customer's work to another billing project.
  if (!data) {
    const apiKey = (process.env.COMPOSIO_API_KEY || process.env.COMPOSIO_PROJECT_API_KEY || '').trim();
    if (!apiKey) throw new ConnectorError('NOT_CONFIGURED', 'No platform or workspace Composio credential is configured.', 422);
    if (apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey)) throw new ConnectorError('CREDENTIAL_UNAVAILABLE', 'The platform connector credential is invalid.', 503);
    return { apiKey, revision: `platform:${createHash('sha256').update(apiKey).digest('hex')}`, source: 'platform' };
  }
  if (!data.encrypted_value) throw new ConnectorError('CREDENTIAL_UNAVAILABLE', 'The workspace connector credential could not be read.', 503);
  const apiKey = decryptToken(data.encrypted_value);
  if (!apiKey) throw new ConnectorError('CREDENTIAL_UNAVAILABLE', 'The connector credential could not be read.', 503);
  return { apiKey, revision: createHash('sha256').update(data.encrypted_value).digest('hex'), source: 'byok' };
}

export async function getConnectorProvider(siteId: string, providerId?: string): Promise<ConnectorProvider | null> {
  let query = supabaseAdmin.from('site_connector_providers').select(PROVIDER_COLUMNS)
    .eq('site_id', siteId).eq('provider', 'composio');
  if (providerId) query = query.eq('id', providerId);
  const { data, error } = await query.abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  return data as ConnectorProvider | null;
}

export async function getConnectorPolicy(siteId: string, connectorId: string): Promise<ConnectorPolicy> {
  const { data, error } = await supabaseAdmin.from('connector_policies')
    .select('tool_access_mode,catalog_reads,allowed_tools,allowed_hosts,require_approval,support_publication,revision')
    .eq('site_id', siteId).eq('connector_id', connectorId).abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  return { ...(data ?? { allowed_tools: [], allowed_hosts: [], require_approval: true }),
    tool_access_mode: connectorToolAccessMode(data?.tool_access_mode), catalog_reads: data?.catalog_reads === true };
}

export async function getMemberGrant(siteId: string, userId: string, connectorId: string): Promise<ConnectorMemberGrant | null> {
  const { data, error } = await supabaseAdmin.from('connector_members')
    .select('user_id,can_view,can_use,expires_at,revoked_at').eq('site_id', siteId)
    .eq('connector_id', connectorId).eq('user_id', userId).abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  return data;
}

// A provider descriptor and its current permissions must still be checked before dispatch.
// Never reinterpret a registered reviewed action (including one incompatible with this account).
function catalogSlug(slug: string) {
  return /^[A-Z0-9][A-Z0-9_]{0,149}$/.test(slug) && !slug.startsWith('COMPOSIO_')
    && !REVIEWED_CONNECTOR_TOOLS.some(tool => tool.slug === slug);
}

type CatalogActorCheck = () => Promise<boolean>;

// Only the instance path requests this extra authority. Share the actor lookup
// within one listing, never between requests or execution rechecks.
function catalogActorCheck(context: ConnectorContext, requested: boolean): CatalogActorCheck | undefined {
  if (!requested || context.catalogUserSession !== true || context.host !== 'assistant' || !uuid.safeParse(context.instanceId).success || !uuid.safeParse(context.agentId).success) return;
  let check: Promise<boolean> | undefined;
  return () => check ??= (async () => {
    const { data, error } = await supabaseAdmin.rpc('connector_catalog_read_actor', {
      p_site_id: context.siteId, p_user_id: context.userId, p_instance_id: context.instanceId, p_agent_id: context.agentId,
    }).abortSignal(deadline());
    // A real actor denial is a boolean false. A privilege failure executing this
    // server-only predicate is an infrastructure error, not a missing user or OAuth grant.
    if (error?.code === '42501') throw new ConnectorError('CATALOG_AUTHORIZATION_UNAVAILABLE', 'Connector authorization could not be evaluated.', 503);
    if (error || typeof data !== 'boolean') connectorDatabaseError(error);
    return data === true;
  })();
}

async function assertUse(context: ConnectorContext, connector: Connector, allowRequest: boolean, check?: CatalogActorCheck, action?: string): Promise<AuthorizedConnector> {
  // No delegation is inferred from a background run or an absent human principal.
  if (context.host !== 'assistant' && context.host !== 'direct') {
    throw new ConnectorError('HOST_DISABLED', 'Background connector delegation is not enabled.', 403);
  }
  if (context.host === 'assistant' && !context.agentId) {
    throw new ConnectorError('AGENT_REQUIRED', 'A verified agent identity is required for connector use.', 403);
  }
  const member = await getMemberGrant(context.siteId, context.userId, connector.id);
  const usable = effectiveMemberGrant(connector, member).can_use;
  // The SQL visibility boundary runs first (including manager visibility).
  // A persisted hidden/revoked/expired row is a veto even for a manager.
  if (!usable && (!allowRequest || (member !== null && (member.can_view !== true || member.can_use !== false || !isGrantCurrent(member))))) {
    throw new ConnectorError('ACCESS_DENIED', 'Connector use is not granted to this member.', 403);
  }
  const agentUse = context.agentId ? await requireConnectorAgent(connector, context.agentId, allowRequest) : true;
  const access = await resolveAccountPolicy(connector, context.host, usable && agentUse ? check : undefined,
    context.connectorIdHint === connector.id, action);
  if (usable && agentUse) return access;
  if (allowRequest && context.host === 'assistant' && context.agentId && access.policy.require_approval === true) {
    return { ...access, requestOnly: true };
  }
  throw new ConnectorError('ACCESS_DENIED', 'Connector action is unavailable.', 403);
}

export async function requireConnectorAgent(connector: Connector, agentId: string, allowAbsent = false) {
  uuid.parse(agentId);
  const { data, error } = await supabaseAdmin.from('connector_agents')
    .select('enabled,expires_at,revoked_at').eq('site_id', connector.site_id)
    .eq('connector_id', connector.id).eq('agent_id', agentId).abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  const usable = effectiveAgentGrant(connector, data);
  if (!usable && (!allowAbsent || data !== null)) throw new ConnectorError('ACCESS_DENIED', 'Connector use is not granted to this agent.', 403);
  const agent = await supabaseAdmin.from('agents').select('id').eq('id', agentId)
    .eq('site_id', connector.site_id).eq('status', 'active').abortSignal(deadline()).maybeSingle();
  if (agent.error) connectorDatabaseError(agent.error);
  if (!agent.data) throw new ConnectorError('ACCESS_DENIED', 'Agent is not available for this site.', 403);
  return usable;
}

/** Configuration and grant checks do not consume an approval or authorize dispatch. */
export function resolveConnectorPolicy(connector: Connector, host: string): Promise<AuthorizedConnector> {
  return resolveAccountPolicy(connector, host);
}

async function resolveAccountPolicy(connector: Connector, host: string, check?: CatalogActorCheck, selected = false, action?: string): Promise<AuthorizedConnector> {
  if (!connector.enabled || connector.revocation_pending || connector.provider_status !== 'ACTIVE') {
    throw new ConnectorError('AUTH_REQUIRED', 'This connector is disabled or requires authentication.', 409);
  }
  const policy = await getConnectorPolicy(connector.site_id, connector.id);
  const hostAllowed = policy.allowed_hosts.includes(host);
  const reviewed = policyReviewedTools(connector, policy).length > 0;
  const catalogScope = policy.tool_access_mode === 'all' || (action ? policy.allowed_tools.includes(action) : policy.allowed_tools.some(catalogSlug));
  // Never expose this setting for a guessed/unselected account or for an ineligible
  // principal. For discovery on mixed accounts keep returning the reviewed tools.
  const askForOptIn = selected && policy.catalog_reads === false && (action !== undefined || !reviewed);
  const catalogEligible = !!(check && (policy.catalog_reads === true || askForOptIn) && hostAllowed && catalogScope
    && connector.verified_at && !connector.revocation_dispatched && await check());
  if (!hostAllowed || (!catalogEligible && !reviewed)) {
    throw new ConnectorError('ACCESS_DENIED', 'No tool policy permits this connector operation.', 403);
  }
  const provider = await getConnectorProvider(connector.site_id, connector.provider_id);
  const credential = await loadConnectorCredential(connector.site_id);
  if (!provider || provider.status !== 'active' || provider.credential_revision !== credential.revision) {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'Verify the provider configuration after changing its credential.', 409);
  }
  if (catalogEligible && askForOptIn) {
    throw new ConnectorError('CATALOG_OPT_IN_REQUIRED', 'Ask a workspace manager to enable catalogue reads for the selected connection.', 403);
  }
  return { connector, provider, policy: { ...policy, catalog_reads: catalogEligible && policy.catalog_reads === true } };
}

export async function listUsableConnectors(context: ConnectorContext, allowRequest = false, catalogReads = false): Promise<AuthorizedConnector[]> {
  const connectors = context.connectorIdHint === undefined ? await listVisibleConnectors(context.siteId, context.userId)
    : [await getVisibleConnector(context.siteId, context.userId, context.connectorIdHint)];
  const results: AuthorizedConnector[] = [];
  const check = catalogActorCheck(context, catalogReads);
  for (const connector of connectors) {
    try { results.push(await assertUse(context, connector, allowRequest, check)); }
    catch (error) {
      // This connector was already proven visible by getVisibleConnector. Explain failure for the
      // explicitly selected instance account, but never reveal hidden accounts in broad discovery.
      if (!(error instanceof ConnectorError) || error.status >= 500 || (catalogReads && context.connectorIdHint !== undefined && context.host === 'assistant' && context.instanceId)) throw error;
    }
  }
  return results;
}

export async function resolveConnectorAction(context: ConnectorContext, connectorId: string, toolSlug: string, allowRequest = false, catalogReads = false): Promise<AuthorizedConnector> {
  const access = await resolveAccount(context, connectorId, allowRequest, catalogActorCheck(context, catalogReads && catalogSlug(toolSlug)), toolSlug);
  const catalogCandidate = !access.requestOnly && access.policy.catalog_reads === true && catalogSlug(toolSlug)
    && (access.policy.tool_access_mode === 'all' || access.policy.allowed_tools.includes(toolSlug));
  if (!catalogCandidate && !policyReviewedTools(access.connector, access.policy).some(tool => tool.slug === toolSlug)) {
    throw new ConnectorError('ACCESS_DENIED', 'This connector tool is not permitted.', 403);
  }
  return access;
}

/** Resolve account grants once for discovery. Concrete execution must still resolve the exact action. */
export function resolveUsableAccount(context: ConnectorContext, connectorId: string, allowRequest = false): Promise<AuthorizedConnector> {
  return resolveAccount(context, connectorId, allowRequest);
}

async function resolveAccount(context: ConnectorContext, connectorId: string, allowRequest: boolean, check?: CatalogActorCheck, action?: string): Promise<AuthorizedConnector> {
  if (context.connectorIdHint !== undefined && connectorId !== context.connectorIdHint) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found in the selected account.', 404);
  }
  const connector = await getVisibleConnector(context.siteId, context.userId, connectorId);
  return assertUse(context, connector, allowRequest, check, action);
}
/** Approval executes in the manager's own name on the original allowed host,
 * not with the proposer's agent grant. The caller independently rechecks origin. */
export async function resolveManagerAction(siteId: string, userId: string, id: string, slug: string) {
  await requireConnectorSiteAccess(siteId, userId, true);
  const connector = await getVisibleConnector(siteId, userId, id);
  if (!effectiveMemberGrant(connector, await getMemberGrant(siteId, userId, id)).can_use) {
    throw new ConnectorError('ACCESS_DENIED', 'Manager connector use is not granted.', 403);
  }
  const access = await resolveConnectorPolicy(connector, 'assistant');
  if (!policyReviewedTools(connector, access.policy).some(tool => tool.slug === slug)) {
    throw new ConnectorError('ACCESS_DENIED', 'This connector tool is not permitted.', 403);
  }
  return access;
}

export const authorizeConnectorExecution = (context: ConnectorContext, connectorId: string, toolSlug: string) =>
  resolveConnectorAction(context, connectorId, toolSlug);
