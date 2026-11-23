import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {connectedAccountReady, projectActionAllowed, projectMetadataAction} from './provider-direct-authority';
import type { DirectAuthorizedConnector } from './provider-direct-policy';
import { readTokenProviderBinding } from './provider-project-binding';
import { verifyAccountIdentity, verifyDirectAccountIdentity } from './composio-accounts';
import { getToolkit } from './composio-catalog';
import { createComposioClient, invalidProviderResponse, validateJson, type ComposioClient } from './composio-transport';
import { inputValue, providerValue, safeText, toolkitSlug, toolSlug } from './composio-validation';
import { hashConnectorSchema } from './composio-tool-json';
import { assertProviderToolSucceeded } from './provider-outcome';
import { directActionNameSafe, directEffect, unsupportedDirectTool } from './provider-direct-guards';
import { assertDirectArguments } from './provider-direct-validation';
import { directParameterPlan, directSchemaContract, snapshotDirectJson } from './provider-direct-schema';
import { ConnectorError } from './types';

type JsonObject = Record<string, unknown>;
export type DirectCredential = { apiKey: string; revision: string };
export type DirectEnvelope = { version: string; schema_hash: string; arguments: JsonObject };
export type DirectDescriptor = { version: string; schemaHash: string; parameters: JsonObject; effect: 'read'|'write'|'unknown'; description: string };

const release = z.string().length(11).regex(/^20\d{6}_\d{2}$/);
const envelopeSchema = z.object({ version: release, schema_hash: z.string().length(64).regex(/^[a-f0-9]+$/), arguments: z.record(z.unknown()) }).strict();
const metadataSchema = z.object({
  slug: toolSlug, toolkit: z.object({slug: toolkitSlug}), version: release,
  input_parameters: z.record(z.unknown()), output_parameters: z.record(z.unknown()).nullish(),
  no_auth: z.literal(false), is_deprecated: z.literal(false), deprecated: z.object({ is_deprecated: z.literal(false).optional() }).nullish(),
  // Provider prose and advertised scope requirements are neither arguments nor authority.
  // Tags only describe effects. If their shape is unfamiliar, use no hints,
  // not a fabricated read classification or a denial of an authorized action.
  tags: z.unknown(),
});
const effectTags = z.array(safeText(100)).max(128).catch([]);
function changed(): never {
  throw new ConnectorError('CONNECTOR_SCHEMA_CHANGED', 'The pinned action, account or authorization changed. Describe it again.', 409);
}
function notReady(): never {
  throw new ConnectorError('CONNECTOR_NOT_READY', 'The selected provider account could not be authorized.', 409);
}
function current(expiresAt: string) {
  if (!(Date.parse(expiresAt) > Date.now())) throw new ConnectorError('ACCESS_CHANGED', 'The isolated account authorization expired.', 403);
}

/** Only direct policy resolution may issue the target. Recheck all copies of each
 * identity before sending a site credential, even for metadata-only lookups. */
function verifyLocal(target: DirectAuthorizedConnector, credential: DirectCredential, slug: string) {
  const { connector:c, provider:p, directProof:d, policy } = target;
  if (!d) notReady();
  if (d.kind === 'connected_account') {
    if (!z.string().uuid().safeParse(d.authorizationId).success || !connectedAccountReady(d,c,target.localProjectRef)) notReady();
  } else if (!z.string().uuid().safeParse(d.attestationId).success || typeof d.resourceBoundary !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(d.resourceBoundary)) notReady();
  if (!d.siteId || d.siteId !== c.site_id || d.connectorId !== c.id || d.providerId !== p.id || d.projectId !== p.project_id ||
    d.accountId !== c.provider_account_id || d.toolkitSlug !== c.toolkit_slug || d.authConfigId !== c.auth_config_id || d.credentialRevision !== credential.revision ||
    target.requestOnly || c.provider_id !== p.id || c.provider_project_id !== p.project_id || p.site_id !== c.site_id || p.provider_user_id !== c.site_id ||
    p.provider !== 'composio' || p.status !== 'active' || p.credential_revision !== credential.revision || !credential.revision ||
    !c.verified_at || c.enabled !== true || c.provider_status !== 'ACTIVE' || c.revocation_pending !== false || c.revocation_dispatched ||
    c.provider_account_id === 'instant_account' || !Number.isSafeInteger(c.revision) || !Number.isSafeInteger(policy.revision)) notReady();
  if (!policy.allowed_hosts?.includes('assistant') ||
    !(policy.tool_access_mode === 'all' || (policy.tool_access_mode === 'selected' && policy.allowed_tools?.includes(slug)))) {
    throw new ConnectorError('CONNECTOR_TOOL_DENIED', 'The current policy does not allow direct execution of this action.', 403);
  }
  if (d.kind!=='connected_account') current(d.expiresAt);
  if (d.kind!=='connected_account' && c.supabase_project_ref && (!/^[a-z]{20}$/.test(c.supabase_project_ref) || c.supabase_project_ref !== d.resourceBoundary ||
    !target.localProjectRef || !/^[a-z]{20}$/.test(target.localProjectRef) || c.supabase_project_ref === target.localProjectRef)) notReady();
  if (!directActionNameSafe(c.toolkit_slug, slug) || !projectActionAllowed(c.toolkit_slug,slug,c.supabase_project_ref,d.kind==='connected_account',target.localProjectRef)) unsupportedDirectTool();
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
  // For delegated QUERY actions, use the published argument contract instead of a SQL word veto.
  // Do not turn a free-text query interpreter into a catalog search capability.
  if (directProof.kind==='connected_account' && directProof.authScheme && slug.slice(connector.toolkit_slug.length+1).split('_').includes('QUERY')) {
    const fields=parameters.properties as Record<string, Record<string,unknown>>;
    if (!fields || Object.values(fields).some(field=>
      !['boolean','integer','number'].includes(String(field.type)) &&
      !(field.type==='string' && (['date','date-time','uuid'].includes(String(field.format)) || Array.isArray(field.enum) || typeof field.const==='string')))) {
      throw new ConnectorError('SCHEMA_UNSUPPORTED','This connection supports structured query filters, not an open query input. No execution request was sent.',409);
    }
  }
  const project = connector.supabase_project_ref;
  const projectMetadataOnly = Boolean(project && directProof.kind==='connected_account' && projectMetadataAction(connector.toolkit_slug,slug));
  const effect = directEffect(effectTags.parse(tool.tags), connector.toolkit_slug, slug);
  if (project) {
    const fields=['project_ref','ref'].filter(k=>injected[k]===project);
    if (fields.length!==1 || (directProof.kind==='connected_account' &&
        (!Array.isArray(tool.input_parameters.required) || !tool.input_parameters.required.includes(fields[0])))) unsupportedDirectTool();
    if (projectMetadataOnly) {
      // Inspect the underlying provider tool, not just its narrowed public projection.
      const {properties,required}=tool.input_parameters;
      if (!properties || typeof properties!=='object' || Object.keys(properties).length!==1 ||
          !Array.isArray(required) || required.length!==1 || required[0]!==fields[0] || effect!=='read') unsupportedDirectTool();
    }
  }
  const toolkit = await getToolkit(client, connector.toolkit_slug);
  if (toolkit.toolkit_type !== 'api' || toolkit.enabled === false) unsupportedDirectTool();
  const identify=directProof.kind==='connected_account' && directProof.authScheme===undefined ? verifyAccountIdentity : verifyDirectAccountIdentity;
  const account = await identify(client, {accountId:connector.provider_account_id, userId:provider.provider_user_id,
    toolkitSlug:connector.toolkit_slug, authConfigId:connector.auth_config_id});
  // Never substitute a credential from another connected account or infer provider access from the tool name.
  if (directProof.kind==='connected_account' && directProof.authScheme===undefined) {
    const saved=connector.granted_scopes;
    // The completed consent identifies a business account only for its original narrow grant.
    // Never infer grants from toolkit metadata or a missing scope inventory after reauthorization.
    if (!account.oauth2 || !account.hostedBusinessOauth || toolkit.type!=='native' || !account.scopesKnown || !saved.length ||
        account.scopes.length!==saved.length || saved.some(scope=>!account.scopes.includes(scope))) notReady();
  }
  if (directProof.kind==='connected_account' && directProof.authScheme &&
      !(directProof.authScheme==='API_KEY' ? account.apiKeyAuth : account.oauth2)) notReady();
  if (project && connector.toolkit_slug==='supabase' && !account.hostedSupabasePat) notReady();
  if (account.accountType !== 'PRIVATE' || (!account.oauth2 && !account.apiKeyAuth)) notReady();
  if (directProof.kind!=='connected_account') current(directProof.expiresAt);
  // Only the app decides its grants. The pin binds the execution contract to
  // this verified authority; it is not a cache of provider permission reports.
  // Projection must not expose server secrets/bindings even if upstream metadata
  // repeats them inside a seemingly ordinary field name or enum literal.
  const visible = JSON.stringify(parameters);
  if ([credential.apiKey, project, directProof.kind==='connected_account' ? directProof.authorizationId : directProof.resourceBoundary, connector.provider_account_id, connector.auth_config_id].some(privateValue =>
    privateValue && (visible.includes(JSON.stringify(privateValue)) || (privateValue.length >= 12 && visible.includes(privateValue))))) unsupportedDirectTool();
  const schemaHash = hashConnectorSchema({ mode:'direct-account-v2', slug, toolkit:toolkit.slug, version:tool.version,
    input:hashConnectorSchema(directSchemaContract(tool.input_parameters)),
    output:tool.output_parameters ? hashConnectorSchema(directSchemaContract(tool.output_parameters)) : null,
    parameters, injected, effect,
    directProof:{...directProof}, connectorRevision:connector.revision, projectRef:connector.supabase_project_ref ?? null,
    policyRevision:policy.revision, keyHash, scheme:account.oauth2 ? 'OAUTH2' : 'API_KEY',
    userId:provider.provider_user_id });
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
    if (snapshot.directProof.kind!=='connected_account') current(snapshot.directProof.expiresAt);
    dispatched = true;
    const response = await client.request(`/tools/execute/${slug}`, {method:'POST', body});
    // A provider hint does not independently establish absence of an effect. Never
    // narrow transport ambiguity to a safe read retry, even for a readOnlyHint.
    assertProviderToolSucceeded(response, {effect:'unknown', toolkit:snapshot.connector.toolkit_slug});
    const success = providerValue(z.object({successful:z.literal(true), error:z.null(), data:z.unknown()}), response, true);
    if (!Object.hasOwn(success, 'data')) invalidProviderResponse(true);
    if (snapshot.directProof.kind==='connected_account' && snapshot.directProof.boundProjectRef && projectMetadataAction(snapshot.connector.toolkit_slug,slug)) {
      // Even metadata tools may return organization details, URLs or unrelated fields.
      const ref=snapshot.directProof.boundProjectRef;
      const result=z.object({ref:z.literal(ref),id:z.literal(ref)}).safeParse(success.data);
      if (!result.success) invalidProviderResponse(true);
      // Release only a small status vocabulary, never free-form project names,
      // organization IDs, arbitrary nested records, or URLs.
      const status=z.object({status:z.enum(['ACTIVE_HEALTHY','INACTIVE','PAUSED','RESTORING'])}).safeParse(success.data);
      return {data:{project_verified:true,...(status.success && {status:status.data.status})}};
    }
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
