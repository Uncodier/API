import { ConnectorError, type ConnectorContext } from './types';

export type ConnectorContextResolver = () => Promise<ConnectorContext>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** agentId is selected with the actual server-built prompt, not instance metadata. */
export function assistantConnectorContext(scope: {
  siteId: string; userId?: string; instanceId: string; host: 'assistant' | 'workflow';
  agentId?: string; requestId?: string; sourceDigest?: string; connectorIdHint?: string; catalogUserSession?: true;
}): ConnectorContextResolver {
  const { siteId, userId, instanceId, host, agentId, requestId } = scope;
  return async () => {
    if (host !== 'assistant') throw new ConnectorError('HOST_DISABLED', 'Background connector delegation is not enabled.', 403);
    if (!userId || !agentId || ![siteId, userId, instanceId, agentId].every(value => uuid.test(value))) {
      throw new ConnectorError('AGENT_REQUIRED', 'A verified interactive actor and agent are required.', 403);
    }
    const { requireConnectorSiteAccess } = await import('./account-access');
    await requireConnectorSiteAccess(siteId, userId);
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const { data, error } = await supabaseAdmin.from('remote_instances').select('id')
      .eq('id', instanceId).eq('site_id', siteId).eq('user_id', userId)
      .abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (error) throw new ConnectorError('HOST_IDENTITY_UNAVAILABLE', 'Connector host identity could not be verified.', 503);
    if (!data) {
      throw new ConnectorError('AGENT_REQUIRED', 'This instance has no verified connector actor.', 403);
    }
    // Recheck the pinned prompt identity, never select a replacement on a later call.
    const agent = await supabaseAdmin.from('agents').select('id').eq('id', agentId)
      .eq('site_id', siteId).eq('status', 'active')
      .abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (agent.error) throw new ConnectorError('HOST_IDENTITY_UNAVAILABLE', 'Connector agent identity could not be verified.', 503);
    if (!agent.data) throw new ConnectorError('AGENT_REQUIRED', 'The prompt agent is no longer active.', 403);
    return { siteId, userId, instanceId, host, agentId, ...(scope.catalogUserSession === true && { catalogUserSession: true as const }), ...(requestId ? { requestId, ...(scope.sourceDigest && { sourceDigest: scope.sourceDigest }) } : {}),
      ...(scope.connectorIdHint !== undefined ? { connectorIdHint: scope.connectorIdHint } : {}) };
  };
}