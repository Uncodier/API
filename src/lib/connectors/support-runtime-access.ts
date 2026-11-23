import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { requireConnectorSiteAccess, getVisibleConnector, getMemberGrant, requireConnectorAgent, resolveConnectorPolicy, connectorDatabaseError } from './access';
import { effectiveMemberGrant } from './grant-resolution';
import { assertScopes, scopesAllowed, screenAllowed } from './action-policy';
import { canRequestFromConversation, getReviewedTool, policyReviewedTools } from './reviewed-tools';
import { loadSupportPublication, publicationWindow } from './support-runtime-publication';
import { isPublicationLabel } from './support-public-gmail';
import { modelAccountIdentity } from './model-account-identity';
import type { SupportConnectorScope } from './support-runtime-contract';
import { CONNECTOR_COLUMNS, ConnectorError, type Connector, type ConnectorContext } from './types';

export const PUBLIC_TOOL = 'PUBLISHED_SUPPORT_TITLES';
export const GMAIL = 'GMAIL_FETCH_EMAILS';
export const publicDescription = 'Read the titles of up to five support notices explicitly published by this workspace.';
export const denied = () => new ConnectorError('SUPPORT_UNAVAILABLE', 'This support operation is unavailable.', 403);
const signal = () => AbortSignal.timeout(5000);
const memberContext = (scope: Extract<SupportConnectorScope, { audience: 'member' }>): ConnectorContext =>
  ({ siteId: scope.siteId, agentId: scope.agentId, userId: scope.userId, host: 'assistant' });

type MemberScope = Extract<SupportConnectorScope, { audience: 'member' }>;

// The member must be allowed to see this account. The assigned agent's grant
// authorizes dispatch; only the member's own use grant authorizes raw results.
async function memberAccount(scope: MemberScope, id: string) {
  const connector = await getVisibleConnector(scope.siteId, scope.userId, id);
  if (connector.id !== id || connector.site_id !== scope.siteId) throw denied();
  const row = await getMemberGrant(scope.siteId, scope.userId, id);
  const member = effectiveMemberGrant(connector, row);
  if (row !== null && !member.can_view) throw denied(); // Manager visibility never overrides an explicit restriction.
  const agentUse = await requireConnectorAgent(connector, scope.agentId, true);
  const access = await resolveConnectorPolicy(connector, 'assistant');
  if (!agentUse && !access.policy.require_approval) throw denied();
  return {access: agentUse ? access : {...access, requestOnly: true as const}, releaseMemberResult: member.can_use};
}

export async function authorizeSupportAction(scope: SupportConnectorScope, connectorId: string, slug: string) {
  if (scope.audience === 'member') {
    if (!canRequestFromConversation(slug)) throw denied(); // Same channel ceiling for discovery, direct execution and review.
    const tool = getReviewedTool(slug);
    const context = memberContext(scope);
    const { access, releaseMemberResult } = await memberAccount(scope, connectorId);
    if (!policyReviewedTools(access.connector, access.policy).some(entry => entry.slug === slug)) throw denied();
    if (access.connector.site_id !== scope.siteId || access.connector.id !== connectorId ||
        access.connector.toolkit_slug !== tool.toolkit || !screenAllowed(tool, await loadToolScreenAccess(context))) throw denied();
    assertScopes(access, tool);
    return { tool, access, publication: null, releaseMemberResult };
  }
  if (slug !== PUBLIC_TOOL) throw denied();
  const publication = await loadSupportPublication(scope.siteId, connectorId, scope.audience, scope.agentId);
  if (!publication || !isPublicationLabel(publication.labelId)) throw denied();
  const { data, error } = await supabaseAdmin.from('connectors').select(CONNECTOR_COLUMNS)
    .eq('id', connectorId).eq('site_id', scope.siteId).eq('toolkit_slug', 'gmail').abortSignal(signal()).maybeSingle();
  if (error) connectorDatabaseError(error);
  if (!data || data.id !== connectorId || data.site_id !== scope.siteId || data.toolkit_slug !== 'gmail') throw denied();
  const connector = data as Connector;
  await requireConnectorAgent(connector, scope.agentId);
  const access = await resolveConnectorPolicy(connector, 'assistant');
  const tool = getReviewedTool(GMAIL, 'gmail');
  if (!policyReviewedTools(connector, access.policy).some(entry => entry.slug === GMAIL)) throw denied();
  assertScopes(access, tool);
  return { tool, access, publication };
}

// Cap the authorization fan-out independently of page size. Never paginate on an unauthorized account identifier.
export function supportInventory(scope: SupportConnectorScope) {
  const context = scope.audience === 'member' ? memberContext(scope) : null;
  let screens: ReturnType<typeof loadToolScreenAccess> | undefined;
  return async (id: string) => {
    if (scope.audience !== 'member' || !context) {
      const { tool } = await authorizeSupportAction(scope, id, PUBLIC_TOOL);
      return { tools: [{ ...tool, description: publicDescription, slug: PUBLIC_TOOL }], label: undefined };
    }
    const [{access}, allowedScreens] = await Promise.all([memberAccount(scope, id), screens ??= loadToolScreenAccess(context)]);
    if (access.connector.id !== id || access.connector.site_id !== scope.siteId) throw denied();
    const tools = policyReviewedTools(access.connector, access.policy).filter(tool =>
      canRequestFromConversation(tool.slug) && screenAllowed(tool, allowedScreens) && scopesAllowed(access.connector, tool));
    return { tools, label: modelAccountIdentity(access.connector.id).account_label };
  };
}

export async function candidateWindow(scope: SupportConnectorScope, after: string, exact?: string) {
  if (scope.audience !== 'member') {
    const ids = exact ? [exact] : await publicationWindow(scope.siteId, scope.agentId, scope.audience, after);
    return ids.map(id => ({ id }));
  }
  await requireConnectorSiteAccess(scope.siteId, scope.userId);
  let query = supabaseAdmin.rpc('connector_list_visible', { p_site_id: scope.siteId, p_user_id: scope.userId,
    ...(exact ? { p_connector_id: exact } : {}) }).select('id,toolkit_slug').eq('enabled', true)
    .eq('revocation_pending', false).eq('provider_status', 'ACTIVE').order('id').limit(6);
  if (after) query = query.gt('id', after);
  const { data, error } = await query.abortSignal(signal());
  if (error || !Array.isArray(data) || data.length > 6) connectorDatabaseError(error);
  return data.map((row: { id: string }) => ({ id: row.id }));
}