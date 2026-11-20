import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { requireConnectorSiteAccess, resolveConnectorAction, requireConnectorAgent, resolveConnectorPolicy, connectorDatabaseError, resolveUsableAccount } from './access';
import { assertScopes, scopesAllowed, screenAllowed } from './action-policy';
import { canRequestFromConversation, getReviewedTool, policyReviewedTools } from './reviewed-tools';
import { loadSupportPublication, publicationWindow } from './support-runtime-publication';
import { isPublicationLabel } from './support-public-gmail';
import type { SupportConnectorScope } from './support-runtime-contract';
import { CONNECTOR_COLUMNS, ConnectorError, type Connector, type ConnectorContext } from './types';

export const PUBLIC_TOOL = 'PUBLISHED_SUPPORT_TITLES';
export const GMAIL = 'GMAIL_FETCH_EMAILS';
export const publicDescription = 'Read the titles of up to five support notices explicitly published by this workspace.';
export const denied = () => new ConnectorError('SUPPORT_UNAVAILABLE', 'This support operation is unavailable.', 403);
const signal = () => AbortSignal.timeout(5000);
const memberContext = (scope: Extract<SupportConnectorScope, { audience: 'member' }>): ConnectorContext =>
  ({ siteId: scope.siteId, agentId: scope.agentId, userId: scope.userId, host: 'assistant' });

export async function authorizeSupportAction(scope: SupportConnectorScope, connectorId: string, slug: string) {
  if (scope.audience === 'member') {
    if (!canRequestFromConversation(slug)) throw denied(); // Same channel ceiling for discovery, direct execution and review.
    const tool = getReviewedTool(slug);
    const context = memberContext(scope);
    const access = await resolveConnectorAction(context, connectorId, slug, true);
    if (access.connector.site_id !== scope.siteId || access.connector.id !== connectorId ||
        access.connector.toolkit_slug !== tool.toolkit || !screenAllowed(tool, await loadToolScreenAccess(context))) throw denied();
    assertScopes(access, tool);
    return { tool, access, publication: null };
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
    if (!context) {
      const { tool } = await authorizeSupportAction(scope, id, PUBLIC_TOOL);
      return { tools: [{ ...tool, description: publicDescription, slug: PUBLIC_TOOL }], label: undefined };
    }
    const [access, allowedScreens] = await Promise.all([resolveUsableAccount(context, id, true), screens ??= loadToolScreenAccess(context)]);
    const tools = policyReviewedTools(access.connector, access.policy).filter(tool =>
      canRequestFromConversation(tool.slug) && screenAllowed(tool, allowedScreens) && scopesAllowed(access.connector, tool));
    return { tools, label: access.connector.display_name.slice(0, 100) };
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