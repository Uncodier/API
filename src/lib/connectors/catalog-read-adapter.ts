import { z } from 'zod';
import { changed, readCatalogMetadata, verifyCatalogBinding, unsupportedAction, unsupportedScopes,
  type CatalogReadMetadata, type ConnectorDescriptionInput, type ConnectorToolDescription } from './catalog-read-metadata';
import { assertOrdinaryCatalogAccount, ordinaryCatalogResource, publishedArguments } from './catalog-read-policy';
import { catalogListSchema, catalogListOutput, publishedListSchema } from './catalog-read-schema';
import { projectCatalogList, projectPublishedList, resultUnsupported } from './catalog-read-result';
import { publishedList, sameSet } from './catalog-read-published';
import { verifyAccountIdentity } from './composio-accounts';
import { getToolkit } from './composio-catalog';
import { createComposioClient, type ComposioClient, validateJson } from './composio-transport';
import { inputValue, providerValue, scopesSchema, toolSlug } from './composio-validation';
import { hashConnectorSchema, validateConnectorArguments } from './composio-tool-json';
import { assertProviderToolSucceeded, rethrowReadFailure } from './provider-outcome';
import { validateConnectorInput, assertSupportedSchema } from './schema-validation';
import { ConnectorError } from './types';
import type { ConnectorExecutionInput } from './composio-sessions';

type Args = Record<string, unknown>;
function snapshotBinding(input: ConnectorDescriptionInput): ConnectorDescriptionInput {
  return { ...input, connector: { ...input.connector, granted_scopes: [...input.connector.granted_scopes] },
    credential: { ...input.credential }, provider: input.provider ? { ...input.provider } : undefined };
}

async function planRead(input: ConnectorDescriptionInput, tool: CatalogReadMetadata) {
  const { connector } = input;
  if (connector.toolkit_slug === 'supabase') {
    const { SUPABASE_CATALOG_SLUG, describeSupabaseCatalogRead, supabaseCatalogArguments, projectSupabaseCatalogResult } = await import('./supabase-report-profile');
    if (tool.slug !== SUPABASE_CATALOG_SLUG) unsupportedAction();
    const plan = await describeSupabaseCatalogRead(connector, tool);
    return { ...plan, description: 'Read a bounded report from a published view in the bound project.',
      prepare: (args: Args) => supabaseCatalogArguments(connector, tool, args),
      project: (data: unknown, args: Args) => projectSupabaseCatalogResult(data, connector, args, input.credential.apiKey) };
  }
  const profile = publishedList(connector.toolkit_slug, tool.slug);
  if (profile) {
    if (tool.description !== profile.description) unsupportedAction();
    if (!sameSet(tool.scopes, profile.scopes)) unsupportedScopes();
    const modelSchema = publishedListSchema(tool, profile);
    return { modelSchema, binding: { profile: `${profile.kind}-list-v1`, shape: profile.shape },
      description: profile.kind === 'calendar'
        ? 'List the first page of visible, non-deleted calendars on this account. Shows primary status and access roles, not calendar IDs or names.'
        : `List a bounded first page of active ${profile.resource} on this account. Shows numeric object IDs and short names only; not an inventory or total.`,
      prepare: (args: Args) => publishedArguments(profile, args),
      project: (data: unknown, args: Args) => projectPublishedList(data, profile, Number(args[profile.limitField]), input.credential.apiKey) };
  }
  const resource = ordinaryCatalogResource(tool);
  const { modelSchema, limit } = catalogListSchema(tool.input_parameters);
  const shape = catalogListOutput(tool.output_parameters, resource);
  return { modelSchema, binding: { resource, limit, profile: 'ordinary-list-v1' },
    description: `List a bounded page of ${resource} from the connected account. Returns identifiers and short labels only.`,
    prepare: (args: Args) => args,
    project: (data: unknown, args: Args) => projectCatalogList(data, shape, Number(args[limit]), input.credential.apiKey) };
}

async function prepareRead(client: ComposioClient, input: ConnectorDescriptionInput, requiredScopes: readonly string[], expectedHash?: string) {
  const provider = await verifyCatalogBinding(input);
  const tool = await readCatalogMetadata(client, input);
  const plan = await planRead(input, tool);
  assertSupportedSchema(plan.modelSchema);
  const { connector } = input;
  // Catalogue slug alone does not imply native API (custom/MCP/disabled toolkits never qualify).
  const toolkit = await getToolkit(client, connector.toolkit_slug);
  if (toolkit.enabled === false || toolkit.toolkit_type !== 'api') unsupportedAction();
  // Hash the provider document independently: nested plan/authority data cannot alter its identity.
  const contractHash = hashConnectorSchema(tool);
  const schemaHash = hashConnectorSchema({ mode: 'catalog-read-v1', contractHash, model: plan.modelSchema, binding: plan.binding,
    connector: connector.id, site: connector.site_id, project: provider.project_id, account: connector.provider_account_id,
    authConfig: connector.auth_config_id, revision: provider.credential_revision, providerId: provider.id });
  if (expectedHash && schemaHash !== expectedHash) changed();
  const account = await verifyAccountIdentity(client, { accountId: connector.provider_account_id, userId: provider.provider_user_id,
    toolkitSlug: connector.toolkit_slug, authConfigId: connector.auth_config_id });
  if (account.accountType !== 'PRIVATE') throw new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH', 'An explicitly private connected account is required.', 409);
  if (connector.toolkit_slug === 'supabase') (await import('./supabase-report-profile')).assertSupabaseCatalogAccount(connector, account, requiredScopes);
  else assertOrdinaryCatalogAccount(account, tool, requiredScopes);
  // Neither provider annotations, SQL templates, provider schema, nor config bindings go to the model.
  const descriptor: ConnectorToolDescription = { slug: tool.slug, toolkitSlug: tool.toolkit.slug, toolkitVersion: tool.version,
    description: plan.description, inputSchema: plan.modelSchema, catalogModelSchema: plan.modelSchema, scopeRequirements: null, scopes: tool.scopes, schemaHash };
  return { descriptor, plan, accountId: account.id, providerUserId: provider.provider_user_id };
}

export async function describeCatalogRead(raw: ConnectorDescriptionInput) {
  const input = snapshotBinding(raw);
  return (await prepareRead(createComposioClient(input.credential.apiKey), input, [])).descriptor;
}

export async function executeCatalogRead(raw: ConnectorExecutionInput): Promise<{ successful: true; data: unknown; logId?: undefined }> {
  let dispatched = false;
  try {
    // Snapshot the exact arguments, actor, binding, pin and callback before any asynchronous read.
    const input = snapshotBinding(raw);
    const { schemaHash, beforeDispatch } = raw;
    if (!input.toolkitVersion || !/^[a-f0-9]{64}$/.test(schemaHash)) changed();
    if (!inputValue(z.array(toolSlug).min(1).max(100), raw.allowedTools).includes(input.toolSlug) || typeof beforeDispatch !== 'function') {
      throw new ConnectorError('CONNECTOR_TOOL_DENIED', 'Direct instance read authorization is required for this action.', 403);
    }
    const requiredScopes = inputValue(scopesSchema, raw.requiredScopes);
    validateConnectorArguments(raw.input);
    const args = JSON.parse(JSON.stringify(raw.input)) as Args;
    const client = createComposioClient(input.credential.apiKey);
    const { descriptor, plan, accountId, providerUserId } = await prepareRead(client, input, requiredScopes, schemaHash);
    validateConnectorInput(descriptor.catalogModelSchema, args);
    const dispatchArgs = await plan.prepare(args);
    validateJson(dispatchArgs);
    const body = { connected_account_id: accountId, user_id: providerUserId, version: descriptor.toolkitVersion, arguments: dispatchArgs };
    await beforeDispatch();
    dispatched = true;
    const response = await client.request(`/tools/execute/${descriptor.slug}`, { method: 'POST', body });
    assertProviderToolSucceeded(response, { effect: 'read', toolkit: input.connector.toolkit_slug });
    const envelope = providerValue(z.object({ successful: z.literal(true), error: z.null(), data: z.unknown() }), response, true);
    if (!Object.hasOwn(envelope, 'data')) resultUnsupported();
    const data = await plan.project(envelope.data, args);
    try { validateJson(data); } catch { resultUnsupported(); }
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > 16_384 || serialized.includes(input.credential.apiKey)) resultUnsupported();
    return { successful: true, data };
  } catch (err) {
    if (dispatched) rethrowReadFailure(err);
    if (err instanceof ConnectorError) {
      Object.assign(err, { executed: false, effectStarted: false });
      throw err;
    }
    throw Object.assign(new ConnectorError('CONNECTOR_EXECUTION_DENIED', 'The connector execution could not be authorized.', 403),
      { executed: false, effectStarted: false });
  }
}
