import {authorityStamp} from './provider-direct-authority';
import { z } from 'zod';
import { loadConnectorCredential } from './account-access';
import { parseConnectorToolRef } from './connector-ref';
import { modelAccountIdentity } from './model-account-identity';
import { ConnectorArgumentError } from './connector-argument-error';
import { hashConnectorSchema } from './composio-tool-json';
import { snapshotDirectJson } from './provider-direct-schema';
import type { ConnectorContextResolver } from './host-context';
import { searchDirectTools } from './provider-direct-discovery';
import { directOutputReport } from './provider-direct-output';
import { askProviderResult } from './provider-result-facts';
import { authorizeDirectAction } from './provider-direct-policy';
import { claimDirectDispatch, confirmDirectResultRelease, storeDirectResult } from './provider-direct-receipt';
import { describeDirectTool, executeDirectTool } from './provider-direct-transport';
import { ConnectorError, type ConnectorContext } from './types';
import { createInstanceConnectorDispatcher } from './instance-connector-dispatcher';

const uuid = z.string().uuid();
const pin = z.object({version:z.string().min(1).max(100), schema_hash:z.string().regex(/^[a-f0-9]{64}$/),
  arguments:z.record(z.unknown()), save_record:z.boolean().optional()}).strict();
const changed = () => new ConnectorError('ACCESS_CHANGED', 'Connector authority changed. Describe the selected action again.', 403);

function interactive(context: ConnectorContext) {
  if (context.host !== 'assistant' || context.catalogUserSession !== true ||
      ![context.userId, context.siteId, context.instanceId, context.agentId].every(id => uuid.safeParse(id).success)) {
    throw new ConnectorError('PRIVATE_DESTINATION_REQUIRED', 'Direct connector access requires a signed-in interactive Robots turn.', 403);
  }
  return context;
}

/** The host supplies identity; Policies supplies authorization. Neither search, old receipts nor
 * a provider description can grant use. The same implementation handles every provider toolkit. */
export function createProviderDirectRuntime(resolveContext: ConnectorContextResolver) {
  async function admission(name: string) {
    const {connectorId,toolSlug} = parseConnectorToolRef(name);
    const context = interactive(await resolveContext());
    if (context.connectorIdHint !== undefined && context.connectorIdHint !== connectorId) {
      throw new ConnectorError('NOT_FOUND', 'This tool does not belong to the selected connection.', 404);
    }
    const target = await authorizeDirectAction(context, connectorId, toolSlug);
    const stamp = JSON.stringify([context.siteId,context.userId,context.agentId,context.instanceId,context.requestId,
      context.connectorIdHint,context.sourceDigest,target.connector.id,target.connector.revision,target.connector.provider_account_id,
      target.connector.auth_config_id,target.connector.toolkit_slug,target.provider.id,target.provider.project_id,
      target.provider.provider_user_id,target.provider.credential_revision,target.policy.revision,authorityStamp(target.directProof)]);
    return {context,target,toolSlug,stamp};
  }
  async function credentialFor(a: Awaited<ReturnType<typeof admission>>) {
    const credential = await loadConnectorCredential(a.context.siteId);
    if (credential.revision !== a.target.provider.credential_revision) throw changed();
    return credential;
  }
  async function recheck(name: string, stamp: string) {
    if ((await admission(name)).stamp !== stamp) throw changed();
  }
  return createInstanceConnectorDispatcher(resolveContext,interactive,{
    search:searchDirectTools,
    async describe(name: string) {
      const a = await admission(name);
      const d = await describeDirectTool(a.target, await credentialFor(a), a.toolSlug);
      await recheck(name, a.stamp);
      return {name, tool_origin:'provider' as const, ...modelAccountIdentity(a.target.connector.id), toolkit:a.target.connector.toolkit_slug,
        description:d.description, version:d.version, schema_hash:d.schemaHash, effect:d.effect,
        parameters:{type:'object',additionalProperties:false,required:['version','schema_hash','arguments'],properties:{
          version:{type:'string',const:d.version},schema_hash:{type:'string',const:d.schemaHash},arguments:d.parameters,
          save_record:{type:'boolean',default:false,description:'Set true only when a private record or viewer link is useful for this task.'},
        }}, expected_use:'Use this exact provider reference, account, version and schema for the requested operation. Do not switch accounts or substitute a report. Answer using returned result facts. A private viewer link is optional; set save_record before the call when needed. Do not repeat a call to save it after the fact.'};
    },
    async call(name: string, input: unknown) {
      let dispatchPossible = false;
      try {
        // Validate/snapshot before the first await. Never allow toJSON/accessors to alter a call.
        const snapshot = snapshotDirectJson(input);
        const encoded = JSON.stringify(snapshot);
        if (Buffer.byteLength(encoded) > 32_000) throw new ConnectorArgumentError({path:'arguments',rule:'bounded'});
        const envelope = pin.safeParse(snapshot);
        if (!envelope.success) {
          if (envelope.error.issues.some(issue => issue.path.length === 1 && issue.path[0] === 'save_record')) {
            throw new ConnectorArgumentError({path:'save_record',rule:'type',expected:'boolean'});
          }
          throw new ConnectorError('DESCRIBE_REQUIRED','Use the current version, schema_hash and arguments envelope.',409);
        }
        const a = await admission(name);
        if (!uuid.safeParse(a.context.requestId).success) throw new ConnectorError('PRIVATE_DESTINATION_REQUIRED','A verified human action is required for external dispatch.',403);
        const credential = await credentialFor(a);
        const {version,schema_hash,arguments:args,save_record} = envelope.data;
        const digest = hashConnectorSchema(args);
        let claimId: string | undefined;
        const response = await executeDirectTool(a.target, credential, a.toolSlug, {version,schema_hash,arguments:args}, async () => {
          await recheck(name, a.stamp);
          claimId = await claimDirectDispatch(a.context,a.target,a.toolSlug,version,schema_hash,digest);
          dispatchPossible = true;
        });
        // Never publish the raw response or the owner-only preview to the model.
        if (!dispatchPossible || !claimId) throw new ConnectorError('CONNECTOR_OUTCOME_UNKNOWN','Provider dispatch could not be verified.',502);
        await recheck(name, a.stamp);
        let receipt: {status:'private_result_ready';url:string} | undefined;
        if (save_record === true) {
          try {
            const report = directOutputReport(response.data, credential.apiKey);
            const id = await storeDirectResult(a.context,a.target,a.toolSlug,version,schema_hash,report,claimId);
            if (uuid.safeParse(id).success) receipt = {status:'private_result_ready',url:`/connectors/results/${id}`};
          } catch (error) {
            // Storage failure is not provider failure. The separate release
            // check below must still succeed before any facts can be returned.
            if (error instanceof Error && ['RecoveryError','OpenRouterBillingError'].includes(error.name)) throw error;
          }
        }
        if (!receipt) await confirmDirectResultRelease(claimId);
        const result = askProviderResult(a.target.connector.toolkit_slug, a.toolSlug, response.data);
        return {success:true as const, ...(result ? {result} : {result_omitted:true as const}),
          ...(receipt ? {receipt} : save_record === true ? {record_status:'unconfirmed' as const} : {}),
          guidance: [result
            ? 'Answer using the result facts. A returned count is for this response, not a project or dataset total. Respect coverage limits.'
            : 'No model-readable facts were returned. Do not infer values.',
          receipt ? 'Offer the private viewer link for details.' : save_record === true
            ? 'The action succeeded but saving the private record could not be confirmed.' : '',
          'Do not replay the action to recover or save its result.'].filter(Boolean).join(' ')};
      } catch (error) {
        if (error instanceof ConnectorError) {
          if (!dispatchPossible && !['CONNECTOR_OUTCOME_UNKNOWN','DIRECT_DISPATCH_ALREADY_CLAIMED'].includes(error.code)) {
            Object.assign(error,{executed:false,effectStarted:false});
          } else { Reflect.deleteProperty(error,'executed'); Reflect.deleteProperty(error,'effectStarted'); }
        }
        throw error;
      }
    },
  });
}
export type ProviderDirectRuntime = ReturnType<typeof createProviderDirectRuntime>;