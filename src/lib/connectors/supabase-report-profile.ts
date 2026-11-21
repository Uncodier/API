import { unsupportedScopes, type CatalogReadMetadata } from './catalog-read-metadata';
import type { ComposioAccount } from './composio-accounts';
import { assertReportContract, reportBinding, reportModelSchema, REPORT_SCOPE } from './supabase-report-contract';
import { analyticsDatasetFingerprint, resolveAnalyticsCapability } from './supabase-analytics-sources';
import { directQueryFields } from './supabase-direct-query';
import { reportArguments } from './supabase-report-query';
import { ConnectorError, type Connector } from './types';

export { SUPABASE_CATALOG_SLUG } from './supabase-report-contract';
export { projectSupabaseCatalogResult } from './supabase-report-result';

const publishedOnly = 'Use view/after/limit only for an explicitly requested published report or inventory, not to answer a data question.';

export async function describeSupabaseCatalogRead(connector: Connector, tool: CatalogReadMetadata, localRef?: string) {
  const binding = reportBinding(connector);
  assertReportContract(tool);
  const published = reportModelSchema();
  const capability = await resolveAnalyticsCapability(connector, localRef);
  if (capability.status !== 'ready') {
    const reason = capability.status === 'unmapped' ? 'No direct analytics sources are registered for this workspace and project.'
      : capability.status === 'unverified' ? 'Makinari could not verify the identity of its own database.'
      : 'Makinari could not verify the analytics source registry.';
    return { modelSchema: published, binding, capability, description: `${reason} ${publishedOnly} Do not ask the user to reconnect. For a data question, explain the limitation and ask the platform operator to check setup.` };
  }
  const direct = directQueryFields(capability.dataset);
  return { modelSchema: { anyOf: [published, { type:'object', additionalProperties:false, properties:direct, required:['query'] }] },
    binding: { ...binding, analytics: analyticsDatasetFingerprint(capability.dataset) }, capability,
    description: `Use query to calculate requested figures directly from the listed sources. ${publishedOnly} Results are private.` };
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
