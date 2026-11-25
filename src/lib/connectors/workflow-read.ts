import 'server-only';
import { z } from 'zod';
import { createComposioClient } from './composio-transport';
import { snapshotDirectJson } from './provider-direct-schema';
import { verifiedWorkflowDescriptor } from './workflow-read-descriptor';
import { checkWorkflowArguments } from './workflow-read-policy';
import { denied, workflowAccount, workflowBinding, type WorkflowConnectorReadBinding } from './workflow-read-binding';
import { directOutputReport, type DirectReport } from './provider-direct-output';
import { ConnectorError } from './types';

export type { WorkflowConnectorReadBinding } from './workflow-read-binding';
const success = z.object({successful:z.literal(true),error:z.null(),data:z.unknown()});

/** Internal scheduled-worker boundary. Only pass the immutable binding from workflow admission.
 * beforeDispatch must atomically claim this run/job, rechecking the tenant/resource proof and unchanged publication. */
export async function runWorkflowConnectorRead(binding:WorkflowConnectorReadBinding, beforeDispatch:()=>Promise<void>):Promise<{executed:true;report:DirectReport}> {
  let dispatched=false;
  try {
    if (typeof beforeDispatch!=='function') denied();
    const b=workflowBinding.parse(snapshotDirectJson(binding));
    const account=await workflowAccount(b,b);
    const client=createComposioClient(account.credential.apiKey);
    const {descriptor,outputContract}=await verifiedWorkflowDescriptor(client,account,b.toolkit_version);
    if (descriptor.schema_hash!==b.schema_hash) denied();
    checkWorkflowArguments(descriptor.input_schema,b.arguments);
    const body={connected_account_id:b.provider_account_id,user_id:b.site_id,version:b.toolkit_version,arguments:b.arguments};
    const fresh=await workflowAccount(b,b);
    if (fresh.credential.apiKey!==account.credential.apiKey || fresh.scopes.length!==account.scopes.length ||
        fresh.scopes.some(s=>!account.scopes.includes(s))) denied();
    if (await beforeDispatch()!==undefined) denied();
    dispatched=true;
    const raw=await client.request(`/tools/execute/${b.tool_slug}`,{method:'POST',body});
    const response=success.parse(raw);
    if (!Object.hasOwn(response,'data')) denied();
    outputContract(raw,b.arguments);
    const report=directOutputReport(response.data, fresh.credential.apiKey, [b.site_id,b.principal_id,b.connector_id,
      b.provider_id,b.provider_project_id,b.provider_user_id,b.provider_account_id,b.auth_config_id,b.credential_revision]);
    return {executed:true,report};
  } catch {
    if (dispatched) throw new ConnectorError('WORKFLOW_READ_UNCONFIRMED','The delegated read returned no verified result.',502);
    denied();
  }
}
