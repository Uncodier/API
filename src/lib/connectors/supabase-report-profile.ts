import { unsupportedScopes, type CatalogReadMetadata } from './catalog-read-metadata';
import type { ComposioAccount } from './composio-accounts';
import { assertReportContract, reportBinding, reportModelSchema, REPORT_SCOPE } from './supabase-report-contract';
import { analyticsDatasetFingerprint, resolveAnalyticsCapability, scopedDataset } from './supabase-analytics-sources';
import { directQueryFields, directQueryMode, projectAnalyticsResult } from './supabase-direct-query';
import { compileAnalyticsSelect, type CompiledAnalyticsSelect } from './supabase-select-compiler';
import { projectSupabaseCatalogResult } from './supabase-report-result';
import type { ConnectorDescriptionInput } from './catalog-read-metadata';
import { reportArguments } from './supabase-report-query';
import { ConnectorError, type Connector } from './types';

export { SUPABASE_CATALOG_SLUG } from './supabase-report-contract';
export { projectSupabaseCatalogResult };

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

/** Compatibility for the Makinari reporting projection of one provider action. Never a toolkit-wide handler. */
export async function prepareSupabaseReport(input: ConnectorDescriptionInput, tool: CatalogReadMetadata) {
  const { connector } = input;
  const plan = await describeSupabaseCatalogRead(connector, tool, input.localProjectRef);
  let compiled: CompiledAnalyticsSelect | undefined;
  return { modelSchema: plan.modelSchema, binding: plan.binding, description: plan.description,
    confirmDataset: async () => {
      if (!compiled || plan.capability.status !== 'ready' || plan.capability.dataset.kind !== 'external' || !('analytics' in plan.binding)) return;
      const fresh = await resolveAnalyticsCapability(connector, input.localProjectRef);
      if (fresh.status === 'unverified' || fresh.status === 'unavailable') {
        throw new ConnectorError('CATALOG_AUTHORIZATION_UNAVAILABLE', 'The current analytics source could not be verified.', 503);
      }
      if (fresh.status !== 'ready' || analyticsDatasetFingerprint(fresh.dataset) !== plan.binding.analytics) {
        throw new ConnectorError('ACCESS_CHANGED', 'The analytics source changed before query dispatch or private delivery.', 403);
      }
    },
    prepare: async (args: Record<string, unknown>) => {
      const scope = directQueryMode(args);
      if (scope === null) return supabaseCatalogArguments(connector, tool, args);
      if (!input.authorizeSelect) throw new ConnectorError('PRIVATE_DESTINATION_REQUIRED', 'A verified private SQL destination is required.', 403);
      compiled = compileAnalyticsSelect(args.query, args.parameters, scopedDataset(plan.capability, scope));
      const ref = connector.supabase_project_ref!;
      await input.authorizeSelect({ scope, source: compiled.source, projectRef: ref });
      return { ref, query: compiled.query, parameters: compiled.parameters };
    },
    project: (data: unknown, args: Record<string, unknown>) => compiled ? projectAnalyticsResult(data, compiled, input.credential.apiKey)
      : projectSupabaseCatalogResult(data, connector, args, input.credential.apiKey) };
}

export function assertSupabaseCatalogAccount(connector: Connector, account: ComposioAccount, requiredScopes: readonly string[]) {
  reportBinding(connector);
  if (account.accountType !== 'PRIVATE' || account.id !== connector.provider_account_id || account.toolkitSlug !== 'supabase' ||
    account.authConfigId !== connector.auth_config_id || account.status !== 'ACTIVE' || account.disabled || account.authConfigDisabled ||
    (account.userId !== undefined && account.userId !== connector.site_id) || !account.hostedSupabasePat || account.oauth2) {
    throw new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH', 'Use the verified private hosted Supabase token account for this project.', 409);
  }
  // The provider, not an invented OAuth grant, enforces this single pinned PAT operation's permission.
  if (requiredScopes.some(s => s !== REPORT_SCOPE)) unsupportedScopes();
}
