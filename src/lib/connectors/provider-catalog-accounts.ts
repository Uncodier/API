import 'server-only';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, getConnectorProvider, getVisibleConnector, listVisibleConnectors } from './account-access';
import { effectiveMemberGrant } from './grant-resolution';
import { ConnectorError, type AuthorizedConnector, type ConnectorContext, type ConnectorMemberGrant, type ConnectorPolicy } from './types';

export type CatalogOnlyAccount = AuthorizedConnector & { catalogOnly: true };

/** Private inventory may show toolkit metadata, never a downstream account schema or result. */
export async function listCatalogOnlyAccounts(ctx: ConnectorContext, excluded: ReadonlySet<string>): Promise<CatalogOnlyAccount[]> {
  const denied = () => new ConnectorError('ACCESS_DENIED', 'Connector inventory requires a verified interactive actor.', 403);
  if (ctx.host !== 'assistant' || ctx.catalogUserSession !== true || !ctx.instanceId || !ctx.agentId) throw denied();
  const deadline = () => AbortSignal.timeout(5_000);
  const { data: actor, error: actorError } = await supabaseAdmin.rpc('connector_direct_actor', {
    p_site_id: ctx.siteId, p_user_id: ctx.userId, p_instance_id: ctx.instanceId, p_agent_id: ctx.agentId,
  }).abortSignal(deadline());
  if (actorError || typeof actor !== 'boolean') connectorDatabaseError(actorError);
  if (!actor) throw denied();

  const visible = ctx.connectorIdHint ? [await getVisibleConnector(ctx.siteId, ctx.userId, ctx.connectorIdHint)]
    : await listVisibleConnectors(ctx.siteId, ctx.userId);
  const candidates = visible.filter(c => !excluded.has(c.id) && c.site_id === ctx.siteId &&
    (!ctx.connectorIdHint || c.id === ctx.connectorIdHint) && c.enabled && c.provider_status === 'ACTIVE' && c.verified_at &&
    c.revocation_pending === false && c.revocation_dispatched === false && c.provider_account_id !== 'instant_account');
  if (!candidates.length) return [];
  if (candidates.length + excluded.size > 100) throw new ConnectorError('CATALOG_LIMIT', 'Select one account to list its actions.', 422);
  const ids = candidates.map(c => c.id);
  const [policies, grants, provider] = await Promise.all([
    supabaseAdmin.from('connector_policies').select('connector_id,revision,allowed_tools,allowed_hosts,require_approval,tool_access_mode')
      .eq('site_id', ctx.siteId).in('connector_id', ids).abortSignal(deadline()),
    supabaseAdmin.from('connector_members').select('connector_id,user_id,can_view,can_use,expires_at,revoked_at')
      .eq('site_id', ctx.siteId).eq('user_id', ctx.userId).in('connector_id', ids).abortSignal(deadline()),
    getConnectorProvider(ctx.siteId),
  ]);
  if (policies.error || grants.error || !Array.isArray(policies.data) || !Array.isArray(grants.data)) connectorDatabaseError(policies.error || grants.error);
  if (!provider || provider.site_id !== ctx.siteId || provider.provider !== 'composio' ||
      provider.status !== 'active' || provider.provider_user_id !== ctx.siteId) return [];

  const byPolicy = new Map<string, ConnectorPolicy>(policies.data.map(p => [p.connector_id, p]));
  const byMember = new Map<string, ConnectorMemberGrant>(grants.data.map(g => [g.connector_id, g]));
  return candidates.flatMap(connector => {
    const policy = byPolicy.get(connector.id);
    if (connector.provider_id !== provider.id || connector.provider_project_id !== provider.project_id ||
        !effectiveMemberGrant(connector, byMember.get(connector.id) ?? null).can_use || !policy?.allowed_hosts.includes('assistant') ||
        !(policy.tool_access_mode === 'all' || (policy.tool_access_mode === 'selected' && policy.allowed_tools.length > 0))) return [];
    return [{ connector, provider, policy, catalogOnly: true }];
  });
}