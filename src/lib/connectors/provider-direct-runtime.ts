import { z } from 'zod';
import { loadConnectorCredential } from './account-access';
import { parseConnectorToolRef } from './connector-ref';
import { ConnectorArgumentError } from './connector-argument-error';
import { hashConnectorSchema } from './composio-tool-json';
import { snapshotDirectJson } from './provider-direct-schema';
import type { ConnectorContextResolver } from './host-context';
import { searchDirectTools } from './provider-direct-discovery';
import { directOutputReport } from './provider-direct-output';
import { authorizeDirectAction } from './provider-direct-policy';
import { claimDirectDispatch, storeDirectResult } from './provider-direct-receipt';
import { describeDirectTool, executeDirectTool } from './provider-direct-transport';
import { ConnectorError, type ConnectorContext } from './types';
import { createInstanceConnectorDispatcher } from './instance-connector-dispatcher';

const uuid = z.string().uuid();
const pin = z.object({version:z.string().min(1).max(100), schema_hash:z.string().regex(/^[a-f0-9]{64}$/),
  arguments:z.record(z.unknown())}).strict();
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
      target.provider.provider_user_id,target.provider.credential_revision,target.policy.revision,target.directProof.attestationId,target.directProof.directRevision]);
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
      return {name, connector_id:a.target.connector.id, toolkit:a.target.connector.toolkit_slug,
        description:d.description, version:d.version, schema_hash:d.schemaHash, effect:d.effect,
        parameters:{type:'object',additionalProperties:false,required:['version','schema_hash','arguments'],properties:{
          version:{type:'string',const:d.version},schema_hash:{type:'string',const:d.schemaHash},arguments:d.parameters,
        }}, expected_use:'Use this exact account, version and schema. Only perform the operation requested by the user. A private receipt is not the data. Never replay an unconfirmed action.'};
    },
    async call(name: string, input: unknown) {
      let dispatchPossible = false;
      try {
        // Validate/snapshot before the first await. Never allow toJSON/accessors to alter a call.
        const snapshot = snapshotDirectJson(input);
        const encoded = JSON.stringify(snapshot);
        if (Buffer.byteLength(encoded) > 32_000) throw new ConnectorArgumentError({path:'arguments',rule:'bounded'});
        const envelope = pin.safeParse(snapshot);
        if (!envelope.success) throw new ConnectorError('DESCRIBE_REQUIRED','Use the current version, schema_hash and arguments envelope.',409);
        const a = await admission(name);
        if (!uuid.safeParse(a.context.requestId).success) throw new ConnectorError('PRIVATE_DESTINATION_REQUIRED','A verified human action is required for external dispatch.',403);
        const credential = await credentialFor(a);
        const {version,schema_hash,arguments:args} = envelope.data;
        const digest = hashConnectorSchema(args);
        let claimId: string | undefined;
        const response = await executeDirectTool(a.target, credential, a.toolSlug, envelope.data, async () => {
          await recheck(name, a.stamp);
          claimId = await claimDirectDispatch(a.context,a.target,a.toolSlug,version,schema_hash,digest);
          dispatchPossible = true;
        });
        // Never publish a provider response to a chat, shared log or recovery checkpoint.
        if (!dispatchPossible || !claimId) throw new ConnectorError('CONNECTOR_OUTCOME_UNKNOWN','Provider dispatch could not be verified.',502);
        try {
          await recheck(name, a.stamp);
          const report = directOutputReport(response.data, credential.apiKey);
          const id = await storeDirectResult(a.context,a.target,a.toolSlug,version,schema_hash,report,claimId);
          if (!uuid.safeParse(id).success) throw new Error('Unverified private destination');
          return {success:true as const, receipt:{status:'private_result_ready' as const,url:`/connectors/results/${id}`},
            guidance:'Give the user this private result link. The model cannot inspect or summarize its contents. Do not replay the action.'};
        } catch {
          throw new ConnectorError('DIRECT_RESULT_UNCONFIRMED','The provider was called, but private delivery could not be confirmed.',503);
        }
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