import { unsupportedScopes, type CatalogReadMetadata } from './catalog-read-metadata';
import type { ComposioAccount } from './composio-accounts';
import { assertReportContract, reportBinding, reportModelSchema, REPORT_SCOPE } from './supabase-report-contract';
import { reportArguments } from './supabase-report-query';
import { ConnectorError, type Connector } from './types';

export { SUPABASE_CATALOG_SLUG } from './supabase-report-contract';
export { projectSupabaseCatalogResult } from './supabase-report-result';

export function describeSupabaseCatalogRead(connector: Connector, tool: CatalogReadMetadata) {
  const binding = reportBinding(connector);
  assertReportContract(tool);
  return { modelSchema: reportModelSchema(), binding };
}

export function supabaseCatalogArguments(connector: Connector, tool: CatalogReadMetadata, args: Record<string, unknown>) {
  assertReportContract(tool);
  return reportArguments(connector, args);
}

export function assertSupabaseCatalogAccount(connector: Connector, account: ComposioAccount, requiredScopes: readonly string[]) {
  reportBinding(connector);
  if (account.accountType !== 'PRIVATE' || account.id !== connector.provider_account_id || account.toolkitSlug !== 'supabase' ||
    account.authConfigId !== connector.auth_config_id || account.status !== 'ACTIVE' || account.disabled || account.authConfigDisabled ||
    (account.userId !== undefined && account.userId !== connector.site_id) || !account.hostedSupabasePat || account.oauth2) {
    throw new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH', 'Use the verified private hosted Supabase token account for this project.', 409);
  }
  // The provider, not an invented OAuth grant, enforces this single pinned PAT operation's permission.
  if (requiredScopes.some(s => s !== REPORT_SCOPE) || account.scopes.some(s => s !== REPORT_SCOPE) ||
    connector.granted_scopes.some(s => s !== REPORT_SCOPE)) unsupportedScopes();
}
