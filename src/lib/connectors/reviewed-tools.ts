import { ConnectorError, connectorToolAccessMode, type Connector, type ConnectorPolicy } from './types';
import { isBoundSupabaseProject, TABLE_TOOL, DATABASE_READ } from './supabase-table-policy';

export type ReviewedConnectorTool = {
  slug: string; toolkit: string; description: string; domains: string[];
  category: string; requiredScreens: string[]; requiredScopes: string[];
};

/** Action-level review, NOT provider categories/tags. Writes and proxy/file tools are excluded.
 * Dispatch uses the explicit version-pinned REST adapter, never SDK/account fallback.
 * CRM reads require both people and leads, matching the native audience boundary.
 */
export const REVIEWED_CONNECTOR_TOOLS: readonly ReviewedConnectorTool[] = [
  { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', description: 'Read emails from the selected Gmail account.', domains: ['communication'], category: 'messaging', requiredScreens: ['chat'], requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  { slug: 'HUBSPOT_LIST_CONTACTS', toolkit: 'hubspot', description: 'Read contacts from the selected HubSpot account.', domains: ['crm'], category: 'crm', requiredScreens: ['people', 'leads'], requiredScopes: ['crm.objects.contacts.read'] },
  { slug: TABLE_TOOL, toolkit: 'supabase', description: 'List table names and their schemas in the connected Supabase project. Excludes views and system schemas; no row data.', domains: ['storage', 'developer'], category: 'infra', requiredScreens: ['applicationsDatabase'], requiredScopes: [DATABASE_READ] },
];

// Historical approval snapshots only. New channel proposals use the provider catalog and explicit agent grants.
export const conversationReviewSlugs = ['GMAIL_FETCH_EMAILS', 'HUBSPOT_LIST_CONTACTS'] as const;
export const canRequestFromConversation = (slug: string) => conversationReviewSlugs.some(value => value === slug);

/** Policy ceiling only. Grants, screens, scopes and exact provider binding still apply. */
export function compatibleReviewedTools(connector: Connector): readonly ReviewedConnectorTool[] {
  return REVIEWED_CONNECTOR_TOOLS.filter(tool => tool.toolkit === connector.toolkit_slug &&
    (tool.slug !== TABLE_TOOL || isBoundSupabaseProject(connector)));
}

export function policyReviewedTools(connector: Connector, policy: ConnectorPolicy): readonly ReviewedConnectorTool[] {
  return compatibleReviewedTools(connector).filter(tool => connectorToolAccessMode(policy.tool_access_mode) === 'all' || policy.allowed_tools.includes(tool.slug));
}

export function getReviewedTool(slug: string, toolkit?: string): ReviewedConnectorTool {
  const tool = REVIEWED_CONNECTOR_TOOLS.find(entry => entry.slug === slug && (!toolkit || entry.toolkit === toolkit));
  if (!tool) throw new ConnectorError('TOOL_UNREVIEWED', 'This connector action has no reviewed execution policy.', 403);
  return tool;
}

// Compatibility for existing channel approvals and historical private report choices.
export { connectorToolRef, parseConnectorToolRef } from './connector-ref';