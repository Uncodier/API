import 'server-only';
import {z} from 'zod';
import {changed} from './catalog-read-metadata';
import {resultUnsupported} from './catalog-read-result';
import {hashConnectorSchema} from './composio-tool-json';
import {scopedAdmission, scopedContract, scopedCredential, scopedVersion} from './instance-scoped-contract';
import {claimScopedRead, storeScopedRead} from './instance-scoped-receipt';
import type {ScopedReadBinding} from './instance-scoped-binding';
import {scopedReport} from './instance-scoped-report';
import {snapshotDirectJson} from './provider-direct-schema';
import {assertProviderToolSucceeded, rethrowReadFailure} from './provider-outcome';
import {SUPABASE_CATALOG_SLUG as slug} from './provider-report-action';
import {validateConnectorInput} from './schema-validation';
import {compileAnalyticsSelect} from './supabase-select-compiler';
import {AnalyticsSelectInputError} from './supabase-select-diagnostics';
import type {AnalyticsScope, BoundDataset} from './supabase-analytics-sources';
import {ConnectorError} from './types';
import {modelAccountIdentity} from './model-account-identity';

export type {ScopedReadBinding} from './instance-scoped-binding';
const pin = z.object({version:z.string().max(100),schema_hash:z.string().length(64).regex(/^[a-f0-9]+$/),arguments:z.record(z.unknown())}).strict();
const success = z.object({successful:z.literal(true),error:z.null(),data:z.unknown()});
const unavailable = () => new ConnectorError('DIRECT_POLICY_UNAVAILABLE','The scoped read could not be authorized.',503);
const changedActor = () => new ConnectorError('ACCESS_CHANGED','The original scoped read binding is no longer current.',403);

const denied = (scope:AnalyticsScope) => new ConnectorError(scope==='workspace'?'ANALYTICS_WORKSPACE_DENIED':'ANALYTICS_SCOPE_DENIED',
  'The exact analytics source and scope are not authorized for this turn.',403);

function compileReport(args:Record<string,unknown>,scope:AnalyticsScope,dataset:BoundDataset) {
  try { return compileAnalyticsSelect(args.query,args.parameters,dataset); }
  catch (error) {
    // The compiler resolves the actual FROM against only this scope's admitted sources.
    // Do not invite an argument repair or substitution for a missing source.
    if (error instanceof AnalyticsSelectInputError && error.reason==='source') throw denied(scope);
    throw error;
  }
}

/** Only the isolated Ask branch supplies this resolver. A descriptor is a pin to check, not
 * a grant. The only provider POST below receives the compiler output, never caller SQL. */
export function createInstanceScopedRead(resolve:()=>Promise<ScopedReadBinding>) {
  async function prepare(name:string) {
    const admission = await scopedAdmission(name,resolve);
    const contract = await scopedContract(admission);
    async function recheck() {
      const fresh = await scopedAdmission(name,resolve);
      if (fresh.stamp !== admission.stamp) throw changedActor();
      const key = await scopedCredential(fresh);
      if (key.apiKey !== contract.credential.apiKey) throw changedActor();
    }
    return {admission,...contract,recheck};
  }
  return {
    async describe(name:string) {
      try {
        const {admission,argumentsSchema,hash,recheck,available} = await prepare(name);
        await recheck();
        return {name,...modelAccountIdentity(admission.actor.p_connector_id),toolkit:'makinari',tool_origin:'makinari_report' as const,effect:'read' as const,
          description:'Internal Makinari metrics report using the selected connection. This is not a provider action or a general SQL console.',
          available_sources:available, version:scopedVersion, schema_hash:hash,
          parameters:{type:'object',additionalProperties:false,required:['version','schema_hash','arguments'],properties:{
            version:{type:'string',const:scopedVersion},schema_hash:{type:'string',const:hash},arguments:argumentsSchema,
          }}, expected_use:'Use the exact selected account and explicitly requested scope. Return only the private receipt; do not infer figures or retry a denied read.'};
      } catch (err) { throw err instanceof ConnectorError ? err : unavailable(); }
    },
    async call(name:string,input:unknown) {
      let sent = false;
      try {
        // Snapshot before the first await. No selectors, view/inventory modes, implicit scope,
        // recovery parameters or other authority-bearing fields are part of the contract.
        const envelope = pin.safeParse(snapshotDirectJson(input));
        if (!envelope.success) throw new ConnectorError('DESCRIBE_REQUIRED','Supply the exact version, schema_hash and arguments envelope.',409);
        if (envelope.data.version !== scopedVersion) changed();
        const args = envelope.data.arguments;
        const plan = await prepare(name);
        const scope = args.scope;
        if (scope !== 'platform' && scope !== 'workspace') throw new ConnectorError('INVALID_TOOL_ARGUMENTS','An explicit analytics scope is required.',400);
        const dataset = plan.datasets[scope];
        if (!dataset) throw denied(scope); // Never compile an unavailable scope using a workspace fallback.
        if (envelope.data.schema_hash !== plan.hash) changed();
        validateConnectorInput(plan.argumentsSchema,args);
        const compiled = compileReport(args,scope,dataset);
        const {actor,binding:{connector,provider}} = plan.admission;
        const authority = {...actor,p_version:scopedVersion,p_schema_hash:plan.hash,p_source:compiled.source,p_data_scope:scope} as const;
        const body = {connected_account_id:connector.provider_account_id,user_id:provider.provider_user_id,version:scopedVersion,
          arguments:{ref:actor.p_project_ref,query:compiled.query,parameters:compiled.parameters}};
        await plan.recheck();
        // This final pre-POST check is an atomic, source/scope-specific claim for the original
        // verified human turn. No awaits, remote catalog probes or scope changes between it and POST.
        const claimId = await claimScopedRead(authority,hashConnectorSchema(args));
        sent = true;
        let raw;
        try {
          raw = await plan.client.request(`/tools/execute/${slug}`,{method:'POST',body});
          assertProviderToolSucceeded(raw,{effect:'read',toolkit:'supabase'});
        } catch (error) { rethrowReadFailure(error); }
        const reply = success.safeParse(raw);
        if (!reply.success || !Object.hasOwn(reply.data,'data')) resultUnsupported();
        const report = scopedReport(reply.data.data,compiled,scope,plan.credential.apiKey);
        const id = await storeScopedRead(authority,claimId,report,plan.recheck);
        await plan.recheck();
        return {success:true as const,receipt:{status:'private_result_ready' as const,url:`/connectors/results/${id}`},
          guidance:'Give the user this private result link. The model cannot inspect or summarize its contents. Do not replay the read.'};
      } catch (err) {
        const error = err instanceof ConnectorError ? err : sent
          ? new ConnectorError('DIRECT_RESULT_UNCONFIRMED','The read was sent, but private delivery could not be confirmed.',503) : unavailable();
        if (!sent && !['DIRECT_DISPATCH_ALREADY_CLAIMED','DIRECT_DISPATCH_UNCONFIRMED'].includes(error.code)) {
          throw Object.assign(error,{executed:false,effectStarted:false});
        }
        Reflect.deleteProperty(error,'executed'); Reflect.deleteProperty(error,'effectStarted');
        throw error;
      }
    },
  };
}
