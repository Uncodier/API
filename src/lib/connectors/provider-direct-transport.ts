import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DirectAuthorizedConnector } from './provider-direct-policy';
import { readTokenProviderBinding } from './provider-project-binding';
import { verifyAccountIdentity } from './composio-accounts';
import { getToolkit } from './composio-catalog';
import { createComposioClient, invalidProviderResponse, validateJson, type ComposioClient } from './composio-transport';
import { inputValue, providerValue, safeText, scopesSchema, toolkitSlug, toolSlug } from './composio-validation';
import { hashConnectorSchema } from './composio-tool-json';
import { assertProviderToolSucceeded } from './provider-outcome';
import { directActionNameSafe, directEffect, unsupportedDirectTool } from './provider-direct-guards';
import { assertDirectArguments } from './provider-direct-validation';
import { directParameterPlan, snapshotDirectJson } from './provider-direct-schema';
import { ConnectorError } from './types';

type JsonObject = Record<string, unknown>;
export type DirectCredential = { apiKey: string; revision: string };
export type DirectEnvelope = { version: string; schema_hash: string; arguments: JsonObject };
export type DirectDescriptor = { version: string; schemaHash: string; parameters: JsonObject; effect: 'read'|'write'|'unknown'; description: string };

const release = z.string().length(11).regex(/^20\d{6}_\d{2}$/);
const envelopeSchema = z.object({ version: release, schema_hash: z.string().length(64).regex(/^[a-f0-9]+$/), arguments: z.record(z.unknown()) }).strict();
const metadataSchema = z.object({
  slug: toolSlug, toolkit: z.object({slug: toolkitSlug}), version: release, description: safeText(16_000), name: safeText(500).optional(),
  input_parameters: z.record(z.unknown()), output_parameters: z.record(z.unknown()).nullish(),
  no_auth: z.literal(false), is_deprecated: z.literal(false), deprecated: z.object({ is_deprecated: z.literal(false).optional() }).nullish(),
  // These are provider metadata, NOT a substitute for the actual app's permission decision.
  scopes: scopesSchema.nullish(), scope_requirements: z.record(z.unknown()).nullish(), tags: z.array(safeText(100)).max(128).optional(),
});
function changed(): never {
  throw new ConnectorError('CONNECTOR_SCHEMA_CHANGED', 'The pinned action, account or authorization changed. Describe it again.', 409);
}
function notReady(): never {
  throw new ConnectorError('CONNECTOR_NOT_READY', 'An active, verified and independently isolated account is required.', 409);
}
function current(expiresAt: string) {
  if (!(Date.parse(expiresAt) > Date.now())) throw new ConnectorError('ACCESS_CHANGED', 'The isolated account authorization expired.', 403);
}

/** Only direct policy resolution may issue the target. Recheck all copies of each
 * identity before sending a site credential, even for metadata-only lookups. */
function verifyLocal(target: DirectAuthorizedConnector, credential: DirectCredential, slug: string) {
  const { connector:c, provider:p, directProof:d, policy } = target;
  if (!d || !z.string().uuid().safeParse(d.attestationId).success || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(d.resourceBoundary) ||
    typeof d.resourceBoundary !== 'string' || !d.siteId || d.siteId !== c.site_id || d.connectorId !== c.id || d.providerId !== p.id || d.projectId !== p.project_id ||
    d.accountId !== c.provider_account_id || d.toolkitSlug !== c.toolkit_slug || d.authConfigId !== c.auth_config_id || d.credentialRevision !== credential.revision ||
    target.requestOnly || c.provider_id !== p.id || c.provider_project_id !== p.project_id || p.site_id !== c.site_id || p.provider_user_id !== c.site_id ||
    p.provider !== 'composio' || p.status !== 'active' || p.credential_revision !== credential.revision || !credential.revision ||
    !c.verified_at || c.enabled !== true || c.provider_status !== 'ACTIVE' || c.revocation_pending !== false || c.revocation_dispatched ||
    c.provider_account_id === 'instant_account' || !Number.isSafeInteger(c.revision) || !Number.isSafeInteger(policy.revision)) notReady();
  if (!policy.allowed_hosts?.includes('assistant') ||
    !(policy.tool_access_mode === 'all' || (policy.tool_access_mode === 'selected' && policy.allowed_tools?.includes(slug)))) {
    throw new ConnectorError('CONNECTOR_TOOL_DENIED', 'The current policy does not allow direct execution of this action.', 403);
  }
  current(d.expiresAt);
  if (c.supabase_project_ref && (!/^[a-z]{20}$/.test(c.supabase_project_ref) || c.supabase_project_ref !== d.resourceBoundary ||
    !target.localProjectRef || !/^[a-z]{20}$/.test(target.localProjectRef) || c.supabase_project_ref === target.localProjectRef)) notReady();
  if (!directActionNameSafe(c.toolkit_slug, slug)) unsupportedDirectTool();
}

async function prepare(target: DirectAuthorizedConnector, credential: DirectCredential, client: ComposioClient, slug: string, version?: string) {
  verifyLocal(target, credential, slug);
  if (version !== undefined) inputValue(release, version);
  const {connector, provider, directProof, policy} = target;
  const binding = await readTokenProviderBinding(connector.site_id, credential.revision);
  const keyHash = createHash('sha256').update(credential.apiKey).digest('hex');
  if (binding.projectId !== provider.project_id || (credential.revision.startsWith('platform:') && credential.revision !== `platform:${keyHash}`)) notReady();
  const raw = await client.request(`/tools/${slug}${version ? `?version=${version}` : ''}`);
  try { validateJson(raw); } catch { invalidProviderResponse(); }
  const tool = providerValue(metadataSchema, raw);
  if (tool.slug !== slug || tool.toolkit.slug !== connector.toolkit_slug || (version !== undefined && version !== tool.version)) changed();
  const {parameters, injected} = directParameterPlan(tool.input_parameters, connector.supabase_project_ref ?? undefined);
  // For a database-bound connection, a project-management action may not select
  // a different project or enumerate all projects. Never infer a project from a slug/argument.
  if (connector.supabase_project_ref && /(?:^|_)PROJECTS?(?:_|$)/.test(slug.slice(connector.toolkit_slug.length + 1)) &&
    !Object.hasOwn(injected,'project_ref')) unsupportedDirectTool();
  const toolkit = await getToolkit(client, connector.toolkit_slug);
  if (toolkit.toolkit_type !== 'api' || toolkit.enabled === false) unsupportedDirectTool();
  const account = await verifyAccountIdentity(client, {accountId:connector.provider_account_id, userId:provider.provider_user_id,
    toolkitSlug:connector.toolkit_slug, authConfigId:connector.auth_config_id});
  if (account.accountType !== 'PRIVATE' || (!account.oauth2 && !account.apiKeyAuth) || account.hostedSupabasePat) notReady();
  current(directProof.expiresAt);
  // Pin raw contract (including annotations, scope metadata and output), local projection,
  // policy epoch, positive isolation proof, effective credential, live identity and grants.
  // No credential, resource identifier, provider prose or scope goes into the description.
  const effect = directEffect(tool.tags ?? [], toolkit.slug, slug);
  // Projection must not expose server secrets/bindings even if upstream metadata
  // repeats them inside a seemingly ordinary field name or enum literal.
  const visible = JSON.stringify(parameters);
  if ([credential.apiKey, directProof.resourceBoundary, connector.provider_account_id, connector.auth_config_id].some(privateValue =>
    privateValue && (visible.includes(JSON.stringify(privateValue)) || (privateValue.length >= 12 && visible.includes(privateValue))))) unsupportedDirectTool();
  const schemaHash = hashConnectorSchema({ mode:'direct-account-v1', metadata:hashConnectorSchema(raw), parameters, effect,
    directProof:{...directProof}, connectorRevision:connector.revision, projectRef:connector.supabase_project_ref ?? null,
    policyRevision:policy.revision, keyHash, scheme:account.oauth2 ? 'OAUTH2' : 'API_KEY',
    scopesKnown:account.scopesKnown, reportedScopes:[...account.scopes].sort(), userId:provider.provider_user_id });
  const descriptor: DirectDescriptor = {version:tool.version, schemaHash, parameters, effect,
    description:`${slug} on the selected private connection. Provider result data is delivered privately, not to the model.`};
  return { descriptor, injected, accountId:account.id, userId:provider.provider_user_id };
}

export async function describeDirectTool(target: DirectAuthorizedConnector, credential: DirectCredential, slug: string, version?: string): Promise<DirectDescriptor> {
  // Do not retain mutable target/credential references across an async provider read.
  const creds = {...credential};
  return (await prepare(structuredClone(target), creds, createComposioClient(creds.apiKey), slug, version)).descriptor;
}

/** Server-internal only. The caller reauthorizes and durably claims these exact arguments
 * in beforeDispatch. It must store/project successful data privately, never return it to
 * a model. No retries, sessions, automatic auth, proxy calls, or fallback accounts. */
export async function executeDirectTool(target: DirectAuthorizedConnector, credential: DirectCredential, slug: string,
  envelope: DirectEnvelope, beforeDispatch: () => Promise<void>): Promise<{data:unknown}> {
  let dispatched = false;
  try {
    if (typeof beforeDispatch !== 'function') notReady();
    const pin = inputValue(envelopeSchema, snapshotDirectJson(envelope));
    const snapshot = structuredClone(target);
    const creds = {...credential};
    const client = createComposioClient(creds.apiKey);
    const {descriptor, injected, accountId, userId} = await prepare(snapshot, creds, client, slug, pin.version);
    if (pin.schema_hash !== descriptor.schemaHash) changed();
    assertDirectArguments(descriptor.parameters, pin.arguments);
    const body = {connected_account_id:accountId, user_id:userId, version:descriptor.version, arguments:{...pin.arguments,...injected}};
    await beforeDispatch();
    current(snapshot.directProof.expiresAt);
    dispatched = true;
    const response = await client.request(`/tools/execute/${slug}`, {method:'POST', body});
    // A provider hint does not independently establish absence of an effect. Never
    // narrow transport ambiguity to a safe read retry, even for a readOnlyHint.
    assertProviderToolSucceeded(response, {effect:'unknown', toolkit:snapshot.connector.toolkit_slug});
    const success = providerValue(z.object({successful:z.literal(true), error:z.null(), data:z.unknown()}), response, true);
    if (!Object.hasOwn(success, 'data')) invalidProviderResponse(true);
    return {data:success.data};
  } catch (err) {
    if (dispatched) {
      if (err instanceof ConnectorError) throw err;
      invalidProviderResponse(true);
    }
    const error = err instanceof ConnectorError ? err : new ConnectorError('CONNECTOR_EXECUTION_DENIED', 'The connector execution could not be authorized.', 403);
    throw Object.assign(error, {executed:false, effectStarted:false});
  }
}
