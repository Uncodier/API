import 'server-only';
import { z } from 'zod';
import { loadConnectorCredential } from './account-access';
import { hashConnectorSchema } from './composio-tool-json';
import { modelAccountIdentity } from './model-account-identity';
import { selectedCatalogAccount } from './selected-catalog-account';
import { SELECTED_QUERY_PROBE, selectedQueryProbeEligible } from './selected-query-probe-policy';
import { prepareSelectedQueryProbe } from './selected-query-probe-transport';
import { ConnectorError, type ConnectorContext } from './types';

const denied = () => new ConnectorError('DIRECT_POLICY_REQUIRED', 'The selected connection test is not authorized.', 403);
const changed = () => new ConnectorError('ACCESS_CHANGED', 'The selected connection test is no longer current.', 403);
const duplicate = () => new ConnectorError('PROBE_ALREADY_ATTEMPTED', 'This connection test has already been attempted for the turn.', 409);
const guidance = 'Only report that the selected connection passed SELECT 1. No user data was read or returned, and data access was not verified.';

/** Only the exact literal is admissible; a request for data must never become a connectivity test. */
export function createSelectedQueryProbeRuntime(resolveInteractive: () => Promise<ConnectorContext>) {
  async function admit(id: string) {
    const ctx = await resolveInteractive();
    if (ctx.connectorIdHint !== id) throw new ConnectorError('NOT_FOUND', 'An explicit account selection is required.', 404);
    if (!ctx.agentId || !z.string().uuid().safeParse(ctx.requestId).success || (ctx.sourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(ctx.sourceDigest))) {
      throw new ConnectorError('PRIVATE_DESTINATION_REQUIRED', 'A verified interactive user request is required.', 403);
    }
    // This verifies the active prompt actor; the signed-in member is the connector grant principal.
    const target = await selectedCatalogAccount(ctx, id, true);
    if (!selectedQueryProbeEligible(target)) throw denied();
    if ((await loadConnectorCredential(ctx.siteId)).revision !== target.provider.credential_revision) throw changed();
    return {target, ctx, stamp: hashConnectorSchema({ctx:{...ctx,sourceDigest:ctx.sourceDigest ?? null}, target})};
  }
  async function recheck(id: string, stamp: string) {
    if ((await admit(id)).stamp !== stamp) throw changed();
  }
  async function prepare(id: string) {
    const admission = await admit(id);
    const probe = await prepareSelectedQueryProbe(admission.target);
    const schemaHash = hashConnectorSchema([SELECTED_QUERY_PROBE, admission.stamp, probe.version, probe.schemaHash]);
    return {...admission, probe, schemaHash};
  }
  return {
    async describe(name: string, id: string) {
      const {probe, schemaHash, stamp} = await prepare(id);
      await recheck(id, stamp);
      return {name, tool_origin:'provider' as const, ...modelAccountIdentity(id), toolkit:'supabase',
        description:'Test the selected Supabase connection with SELECT 1; no table reads are authorized.',
        effect:'read' as const, version:probe.version, schema_hash:schemaHash,
        parameters:{type:'object', additionalProperties:false, required:['version','schema_hash','arguments'], properties:{
          version:{type:'string',const:probe.version}, schema_hash:{type:'string',const:schemaHash},
          arguments:{type:'object',required:['query'],properties:{query:{type:'string',const:'SELECT 1'}},additionalProperties:false},
        }}, expected_use:'Use only for a requested connection test. Never substitute SELECT 1 for a data query or retry an unconfirmed attempt.'};
    },
    async call(id: string, envelope: {version:string; schema_hash:string; arguments:Record<string,unknown>}) {
      let dispatchPossible = false;
      try {
        if (Object.keys(envelope.arguments).length !== 1 || envelope.arguments.query !== 'SELECT 1') throw new ConnectorError('DIRECT_ACTION_UNSUPPORTED', 'This test cannot run a data request.', 409);
        const {probe, schemaHash, stamp, ctx} = await prepare(id);
        if (probe.version !== envelope.version || schemaHash !== envelope.schema_hash) {
          throw new ConnectorError('CONNECTOR_SCHEMA_CHANGED', 'Describe the selected test for this turn.', 409);
        }
        await probe.execute(async () => {
          if (dispatchPossible) throw duplicate();
          await reserveAttempt(ctx, id);
          await recheck(id, stamp);
          dispatchPossible = true;
        });
        if (!dispatchPossible) throw new ConnectorError('CONNECTOR_OUTCOME_UNKNOWN', 'The test was not verified.', 502);
        await recheck(id, stamp);
        return {success:true as const, connection_test:'verified' as const, guidance};
      } catch (error) {
        if (dispatchPossible) {
          if (error instanceof ConnectorError && ['PROVIDER_FORBIDDEN','APP_RESOURCE_DENIED'].includes(error.code)) {
            throw new ConnectorError(error.code, 'The provider denied this operation.', 403);
          }
          throw new ConnectorError('PROBE_UNCONFIRMED', 'No result could be confirmed for this operation. Do not retry.', 502);
        }
        if (error instanceof ConnectorError && !['PROBE_ALREADY_ATTEMPTED','DIRECT_DISPATCH_UNCONFIRMED','CONNECTOR_OUTCOME_UNKNOWN'].includes(error.code)) {
          Object.assign(error,{executed:false,effectStarted:false});
        }
        throw error;
      }
    },
  };
}

// Gate independent gateway instances, including parallel calls. Never key by mutable policy,
// credential or schema revision: rotating one must not authorize a replay on the same turn.
async function reserveAttempt(ctx: ConnectorContext, id: string) {
  const key = 'connectors:connection-test:' + hashConnectorSchema([ctx.siteId, ctx.instanceId, ctx.userId, ctx.requestId, id]);
  let result;
  try {
    const { getRedisClient } = await import('@/lib/utils/redis-client');
    result = await getRedisClient().set(key, '1', 'EX', 86_400, 'NX');
  } catch { throw new ConnectorError('DIRECT_DISPATCH_UNCONFIRMED', 'The attempt could not be reserved.', 503); }
  if (result === null) throw duplicate();
  if (result !== 'OK') throw new ConnectorError('DIRECT_DISPATCH_UNCONFIRMED', 'The attempt could not be reserved.', 503);
}
