import { DATABASE_READ, TABLE_TOOL, isBoundSupabaseProject } from './supabase-table-policy';
import { canUseToolScreen, type ToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { ConnectorError, type AuthorizedConnector, type Connector } from './types';
import type { ReviewedConnectorTool } from './reviewed-tools';

export function screenAllowed(tool: ReviewedConnectorTool, access: ToolScreenAccess | null): boolean {
  return !!access && canUseToolScreen('connector_gateway', access) &&
    (access.isAdmin || tool.requiredScreens.every(screen => !access.blockedScreens.includes(screen)));
}

/** Bound PAT permissions are enforced by the provider on this one fixed-name-list action;
 * they are not OAuth grants and never qualify other actions or broader scopes. */
export function scopesAllowed(connector: Connector, tool: ReviewedConnectorTool, extra: readonly string[] = []): boolean {
  const scopes = [...tool.requiredScopes, ...extra];
  return tool.slug === TABLE_TOOL
    ? isBoundSupabaseProject(connector) && scopes.every(scope => scope === DATABASE_READ)
    : scopes.every(scope => connector.granted_scopes.includes(scope));
}

export function assertScopes(value: AuthorizedConnector, tool: ReviewedConnectorTool, scopes: readonly string[] = []): void {
  if (!scopesAllowed(value.connector, tool, scopes)) {
    throw new ConnectorError('SCOPES_REQUIRED', 'This connector does not have the reviewed permissions.', 403);
  }
}
