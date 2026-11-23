import 'server-only';
import { z } from 'zod';
import { loadConnectorCredential } from './account-access';
import { verifyDirectAccountIdentity } from './composio-accounts';
import { getToolkit } from './composio-catalog';
import { hashConnectorSchema } from './composio-tool-json';
import { createComposioClient, validateJson } from './composio-transport';
import type { CatalogOnlyAccount } from './selected-catalog-account';
import { PROBE_PROVIDER_ACTION as slug, selectedQueryProbeEligible } from './selected-query-probe-policy';
import { readTokenProviderBinding } from './provider-project-binding';
import { assertProviderToolSucceeded } from './provider-outcome';
import { ConnectorError } from './types';

const version = '20261116_00';
// Canonical SHA-256 of both wire schemas in fixtures/supabase-report-20261116_00.json.
const reviewedSchemas = '6592f367be55ab38135ddf4584e005bae5e4f32e52f09f7e9ba910127d5e9393';
const tags = ['important', 'readOnlyHint', 'openWorldHint', 'Database'];
const descriptor = z.object({
  slug: z.literal(slug), version: z.literal(version), toolkit: z.object({ slug: z.literal('supabase') }),
  no_auth: z.literal(false), is_deprecated: z.literal(false),
  deprecated: z.object({ is_deprecated: z.literal(false).optional() }).nullish(),
  scopes: z.tuple([z.literal('database_read')]), scope_requirements: z.null(),
  tags: z.array(z.string()).length(tags.length).refine(values => tags.every(tag => values.includes(tag))),
  input_parameters: z.record(z.unknown()), output_parameters: z.record(z.unknown()),
});
const probeResult = z.object({ successful: z.literal(true), error: z.null().optional(), data: z.object({
  rows_returned: z.literal(1).optional(), result: z.tuple([z.object({ '?column?': z.literal(1) }).strict()]),
}).strict() });

/** Server-only exception to catalog-only access. The caller supplies authority, never SQL.
 * Describe and call each prepare afresh; execute admits a single attempt on the pinned account. */
export async function prepareSelectedQueryProbe(target: CatalogOnlyAccount) {
  const snapshot = structuredClone(target);
  const { connector, provider, policy } = snapshot;
  if (snapshot.catalogOnly !== true || !selectedQueryProbeEligible(snapshot) ||
      typeof connector.supabase_project_ref !== 'string' || connector.supabase_project_ref.length !== 20 ||
      connector.revocation_pending !== false || connector.enabled !== true || connector.provider_account_id === 'instant_account' ||
      provider.provider !== 'composio' || provider.status !== 'active' || provider.site_id !== connector.site_id ||
      provider.provider_user_id !== connector.site_id || connector.provider_id !== provider.id ||
      !provider.project_id || connector.provider_project_id !== provider.project_id ||
      !Number.isSafeInteger(connector.revision) || !Number.isSafeInteger(policy.revision)) {
    throw new ConnectorError('CONNECTOR_TOOL_DENIED', 'The selected connection is not authorized for the connection test.', 403);
  }
  const credential = await loadConnectorCredential(connector.site_id);
  if (!credential.revision || credential.revision !== provider.credential_revision ||
      (await readTokenProviderBinding(connector.site_id, credential.revision)).projectId !== provider.project_id) {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'Verify the provider project binding before testing the connection.', 409);
  }
  const client = createComposioClient(credential.apiKey);
  const metadata = await client.request(`/tools/${slug}?version=${version}`);
  validateJson(metadata);
  const parsed = descriptor.safeParse(metadata);
  if (!parsed.success || hashConnectorSchema({ input_parameters: parsed.data.input_parameters,
    output_parameters: parsed.data.output_parameters }) !== reviewedSchemas) {
    throw new ConnectorError('CONNECTOR_SCHEMA_CHANGED', 'The action no longer matches the reviewed connection test.', 409);
  }
  const kit = await getToolkit(client, 'supabase');
  if (kit.enabled === false || kit.toolkit_type !== 'api') throw new ConnectorError('TOOL_UNREVIEWED', 'The native Supabase API toolkit is required.', 403);
  const account = await verifyDirectAccountIdentity(client, { accountId: connector.provider_account_id, userId: provider.provider_user_id,
    toolkitSlug: 'supabase', authConfigId: connector.auth_config_id });
  if (account.accountType !== 'PRIVATE' || !account.hostedSupabasePat) {
    throw new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH', 'The connection test requires a verified private hosted Supabase token account.', 409);
  }
  const body = { connected_account_id: account.id, user_id: provider.provider_user_id, version,
    arguments: { ref: connector.supabase_project_ref, query: 'SELECT 1' } };
  const schemaHash = hashConnectorSchema({ mode: 'selected-query-probe-v1', slug, toolHash: hashConnectorSchema(parsed.data), body,
    connectorId: connector.id, connectorRevision: connector.revision, policyRevision: policy.revision,
    authConfig: connector.auth_config_id, providerId: provider.id, project: provider.project_id, credentialRevision: credential.revision });
  let consumed = false;
  return { version, schemaHash, async execute(beforeDispatch: () => Promise<void>): Promise<void> {
    if (consumed || typeof beforeDispatch !== 'function') throw new ConnectorError('ACCESS_CHANGED', 'A fresh connection test authorization is required.', 403);
    consumed = true;
    await beforeDispatch();
    const raw = await client.request(`/tools/execute/${slug}`, { method: 'POST', body });
    assertProviderToolSucceeded(raw, { effect: 'read', toolkit: 'supabase' });
    if (!probeResult.safeParse(raw).success) throw new ConnectorError('CONNECTOR_RESULT_UNSUPPORTED', 'The provider did not confirm the connection test.', 502);
  } };
}
