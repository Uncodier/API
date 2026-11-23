import 'server-only';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {loadConnectorCredential} from './account-access';
import {unsupportedAction, unsupportedSchema} from './catalog-read-metadata';
import {verifyDirectAccountIdentity} from './composio-accounts';
import {getToolkit} from './composio-catalog';
import {hashConnectorSchema} from './composio-tool-json';
import {createComposioClient} from './composio-transport';
import {providerId} from './composio-validation';
import {parseConnectorToolRef} from './connector-ref';
import type {ScopedReadBinding} from './instance-scoped-binding';
import {directSchemaContract} from './provider-direct-schema';
import {readTokenProviderBinding} from './provider-project-binding';
import {SUPABASE_CATALOG_SLUG as slug} from './provider-report-action';
import {nativeSources} from './supabase-analytics-native';
import {analyticsDatasetFingerprint, type AnalyticsScope, type BoundDataset} from './supabase-analytics-sources';
import {directQueryFields} from './supabase-direct-query';
import {assertScopedInputContract} from './supabase-report-contract';
import {ConnectorError} from './types';

const uuid = z.string().uuid();
const revision = z.number().int().positive().max(2147483647);
export const scopedVersion = '20261116_00';
// Canonical (annotation-free) output schema from the committed supabase-report-20261116_00 fixture.
const outputPin = '3e773cdd579941e17e4bdf8b4ddf8bc84cd168c11be1d0253f93b280c88dd9c3';
const descriptor=z.object({slug:z.literal(slug),toolkit:z.object({slug:z.literal('supabase')}),version:z.literal(scopedVersion),
  no_auth:z.literal(false),is_deprecated:z.literal(false),deprecated:z.object({is_deprecated:z.literal(false).optional()}).nullish(),
  input_parameters:z.record(z.unknown()),output_parameters:z.record(z.unknown())});
const changed = () => new ConnectorError('ACCESS_CHANGED','The original Ask turn or scoped connection is no longer current.',403);

/** No resolution by toolkit, name, URL or environment. The injected resolver freshly verifies
 * installation identity and member use for the original private turn; it cannot pick a substitute. */
export async function scopedAdmission(name:string, resolve:()=>Promise<ScopedReadBinding>) {
  const {connectorId,toolSlug} = parseConnectorToolRef(name);
  if (toolSlug !== slug) throw new ConnectorError('CONNECTOR_TOOL_DENIED','Only the scoped read action is available here.',403);
  const binding = structuredClone(await resolve());
  const {context,connector:c,provider:p,localProjectRef,policyRevision,directRevision} = binding;
  if (context.host !== 'assistant' || context.catalogUserSession !== true ||
      ![context.siteId,context.userId,context.instanceId,context.agentId,context.requestId].every(id=>uuid.safeParse(id).success)) {
    throw new ConnectorError('PRIVATE_DESTINATION_REQUIRED','A verified private interactive Ask turn is required.',403);
  }
  if (c.id !== connectorId || (context.connectorIdHint !== undefined && context.connectorIdHint !== connectorId)) {
    throw new ConnectorError('NOT_FOUND','This action does not belong to the selected account.',404);
  }
  if (c.site_id !== context.siteId || c.toolkit_slug !== 'supabase' || !c.verified_at || c.enabled !== true ||
      c.provider_status !== 'ACTIVE' || c.revocation_pending !== false || c.revocation_dispatched !== false ||
      c.provider_account_id === 'instant_account' || ![c.revision,policyRevision,directRevision].every(r=>revision.safeParse(r).success) ||
      typeof localProjectRef !== 'string' || localProjectRef.length !== 20 || /[^a-z]/.test(localProjectRef) || c.supabase_project_ref !== localProjectRef ||
      p.id !== c.provider_id || p.provider !== 'composio' || p.status !== 'active' || p.site_id !== c.site_id ||
      p.provider_user_id !== c.site_id || p.project_id !== c.provider_project_id || !/^(platform:)?[a-f0-9]{64}$/.test(p.credential_revision) ||
      ![p.id,p.project_id,c.provider_account_id,c.auth_config_id].every(id=>providerId.safeParse(id).success)) throw changed();
  const actor = {p_site_id:context.siteId,p_user_id:context.userId,p_instance_id:context.instanceId!,p_agent_id:context.agentId!,
    p_request_id:context.requestId!,p_connector_id:connectorId,p_project_ref:localProjectRef,p_connector_revision:c.revision,
    p_policy_revision:policyRevision,p_direct_revision:directRevision,p_credential_revision:p.credential_revision};
  const stamp = hashConnectorSchema({actor,toolSlug,account:c.provider_account_id,config:c.auth_config_id,toolkit:c.toolkit_slug,
    providerId:p.id,project:p.project_id,providerUser:p.provider_user_id,sourceDigest:context.sourceDigest??null,selection:context.connectorIdHint??null});
  return {binding,actor,stamp};
}

type Admission = Awaited<ReturnType<typeof scopedAdmission>>;
export async function scopedCredential({binding:{connector,provider}}:Admission) {
  const key = {...await loadConnectorCredential(connector.site_id)};
  if (key.revision !== provider.credential_revision || (key.source === 'platform') !== key.revision.startsWith('platform:')) throw changed();
  const project = await readTokenProviderBinding(connector.site_id,key.revision);
  if (project.projectId !== provider.project_id || (key.source === 'platform' &&
      key.revision !== `platform:${createHash('sha256').update(key.apiKey).digest('hex')}`)) throw changed();
  return key;
}

// These fixed sources are the entire vocabulary, even if another policy later supports more.
function dataset(scope:AnalyticsScope,site:string):BoundDataset {
  const {paid_sales,tender_awards,approved_orders} = nativeSources(scope);
  return {kind:'native', sources:{paid_sales,tender_awards,approved_orders},
    parameters:scope==='workspace'?[site]:[], ...(scope==='workspace' && {allowRows:true})};
}

export async function scopedContract(a:Admission) {
  const {binding:{connector,provider}} = a;
  const credential = await scopedCredential(a);
  const client = createComposioClient(credential.apiKey);
  // This capability is one versioned read operation with a known wire shape and
  // server-compiled SQL. Tool tags, prose, and OAuth scope hints are not the
  // effective permissions of the selected PAT, and must not gate a valid call.
  const raw=await client.request(`/tools/${slug}?version=${scopedVersion}`);
  const parsed=descriptor.safeParse(raw); if(!parsed.success) unsupportedAction();
  const tool=parsed.data; assertScopedInputContract(tool.input_parameters);
  if (!tool.output_parameters || hashConnectorSchema(directSchemaContract(tool.output_parameters)) !== outputPin) unsupportedSchema();
  const kit = await getToolkit(client,'supabase');
  if (kit.toolkit_type !== 'api' || kit.enabled === false) unsupportedAction();
  const account = await verifyDirectAccountIdentity(client,{accountId:connector.provider_account_id,userId:provider.provider_user_id,
    toolkitSlug:'supabase',authConfigId:connector.auth_config_id});
  // An exact active PRIVATE API_KEY + hosted origin is required. A PAT does not advertise
  // authoritative OAuth grants. Never use its breadth as permission, or switch on a denial.
  if (account.accountType !== 'PRIVATE' || !account.hostedSupabasePat) {
    throw new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH','The exact private hosted Supabase token account is required.',409);
  }
  const datasets = {workspace:dataset('workspace',connector.site_id),platform:dataset('platform',connector.site_id)};
  const {query,parameters} = directQueryFields(datasets.workspace);
  const argumentsSchema = {type:'object',additionalProperties:false,required:['query','scope'],properties:{
    query:{...query,description:query.description.replace('Workspace is the default; ','In workspace scope, ')},parameters,
    scope:{type:'string',enum:['workspace','platform'],description:'Required. Use workspace for this workspace, or platform only for explicitly requested cross-workspace aggregates with an independent grant. Never substitute scopes.'},
  }};
  const hash = hashConnectorSchema({mode:'instance-scoped-native-analytics-v1',name:slug,version:scopedVersion,accountBinding:a.stamp,
    input:hashConnectorSchema(directSchemaContract(tool.input_parameters)),
    outputPin,argumentsSchema,workspace:analyticsDatasetFingerprint(datasets.workspace),
    platform:analyticsDatasetFingerprint(datasets.platform),keyHash:createHash('sha256').update(credential.apiKey).digest('hex')});
  return {client,credential,argumentsSchema,hash,datasets};
}
