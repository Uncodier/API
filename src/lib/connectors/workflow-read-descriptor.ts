import 'server-only';
import { workflowDescriptorMarkers } from './workflow-descriptor-markers';
import { descriptorContainsPrivateValue } from './descriptor-privacy';
import { z } from 'zod';
import { verifyAccountIdentity } from './composio-accounts';
import { getToolkit } from './composio-catalog';
import { hashConnectorSchema } from './composio-tool-json';
import { createComposioClient, validateJson, type ComposioClient } from './composio-transport';
import { acceptsDirectToolkit } from './direct-compatibility';
import { snapshotDirectJson } from './provider-direct-schema';
import { denied, workflowAccount, workflowActor } from './workflow-read-binding';
import { checkScopes, checkWorkflowArguments, metadata, readContract } from './workflow-read-policy';

export const operationRequest = workflowActor.omit({principal_id:true}).extend({arguments:z.record(z.unknown()).optional()}).strict();
export type WorkflowOperationRequest = z.infer<typeof operationRequest>;
export type WorkflowOperationDescriptor = {connector_id:string; toolkit_slug:string; tool_slug:string; toolkit_version:string;
  schema_hash:string; input_schema:Record<string,unknown>};

/** Identity normalization discards endpoint overrides. For an unfamiliar native API do not accept
 * a private account with a custom downstream URL, even if the account reports read-only scopes. */
const endpointFields = z.object({data:z.object({base_url:z.unknown().optional()}).nullish(),
  state:z.object({val:z.object({full:z.unknown().optional()})}).optional()});
async function verifyPrivateAccount(client:ComposioClient, {pin}:Awaited<ReturnType<typeof workflowAccount>>) {
  const path=`/connected_accounts/${pin.provider_account_id}`;
  const raw=await client.request(path);
  const endpoint=endpointFields.parse(raw);
  const account=await verifyAccountIdentity({request:<T>(p:string) => p===path ? Promise.resolve(raw as T) : client.request<T>(p)},
    {accountId:pin.provider_account_id,userId:pin.site_id,toolkitSlug:pin.toolkit_slug,authConfigId:pin.auth_config_id});
  if (account.accountType!=='PRIVATE' || !(account.oauth2 || account.apiKeyAuth) || (!account.apiKeyAuth && !account.scopesKnown) ||
      (endpoint.data?.base_url!=null || endpoint.state?.val.full!=null)) denied();
  return account;
}

/** No host authority, catalogue prose, provider values or credentials are included in the public DTO. */
export async function verifiedWorkflowDescriptor(client:ComposioClient, account:Awaited<ReturnType<typeof workflowAccount>>, version?:string) {
  const {pin}=account;
  const privateMarkers=await workflowDescriptorMarkers(pin);
  const toolkit=await getToolkit(client,pin.toolkit_slug);
  if (!acceptsDirectToolkit(toolkit)) denied();
  const raw=await client.request(`/tools/${pin.tool_slug}${version ? `?version=${version}` : ''}`);
  validateJson(raw);
  const tool=metadata.parse(raw);
  if (tool.slug!==pin.tool_slug || tool.toolkit.slug!==pin.toolkit_slug || (version && tool.version!==version)) denied();
  const {input_schema,outputContract}=readContract(tool);
  if (descriptorContainsPrivateValue(input_schema,[...privateMarkers, account.credential.apiKey, pin.provider_account_id, pin.auth_config_id,
    pin.provider_project_id, pin.credential_revision, pin.provider_user_id, pin.provider_id, pin.connector_id, pin.principal_id, pin.site_id])) denied();
  const live=await verifyPrivateAccount(client,account);
  checkScopes(tool.scopes,account.scopes,live.apiKeyAuth);
  checkScopes(tool.scopes,live.scopes,live.apiKeyAuth);
  if (account.scopes.some(s=>!live.scopes.includes(s)) || live.scopes.some(s=>!account.scopes.includes(s))) denied();
  const schema_hash=hashConnectorSchema({profile:'workflow-read-v1',pin,tool,input_schema,scheme:live.authScheme,grants:[...live.scopes].sort()});
  const descriptor = {connector_id:pin.connector_id, toolkit_slug:toolkit.slug, tool_slug:tool.slug, toolkit_version:tool.version,
    schema_hash,input_schema} satisfies WorkflowOperationDescriptor;
  return {descriptor,outputContract};
}

export async function describeWorkflowOperation(user:string, raw:WorkflowOperationRequest):Promise<WorkflowOperationDescriptor> {
  const request=operationRequest.parse(snapshotDirectJson(raw));
  const actor=workflowActor.parse({...request,principal_id:user});
  const account=await workflowAccount(actor);
  const {descriptor}=await verifiedWorkflowDescriptor(createComposioClient(account.credential.apiKey),account);
  if (request.arguments!==undefined) checkWorkflowArguments(descriptor.input_schema,request.arguments);
  return descriptor;
}
