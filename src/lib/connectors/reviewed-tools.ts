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

// A new private action must never become public-channel requestable by default.
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

const reference = /^connector:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([A-Z][A-Z0-9_]{0,127})$/;
export function parseConnectorToolRef(name: string): { connectorId: string; toolSlug: string } {
  const match = reference.exec(name);
  if (!match) throw new ConnectorError('INVALID_TOOL_REFERENCE', 'Use the exact connector tool reference returned by tools search.', 400);
  return { connectorId: match[1], toolSlug: match[2] };
}

export function connectorToolRef(connectorId: string, toolSlug: string): string {
  const name = `connector:${connectorId}:${toolSlug}`;
  parseConnectorToolRef(name);
  return name;
}