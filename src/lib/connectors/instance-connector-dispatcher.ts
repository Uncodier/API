import {z} from 'zod';
import {parseConnectorToolRef} from './connector-ref';
import type {ConnectorFilters} from './connector-discovery-types';
import type {ConnectorContextResolver} from './host-context';
import {scopedReadPage,scopedReadResolver} from './instance-scoped-binding';
import type {searchDirectTools} from './provider-direct-discovery';
import {instanceSearchTargets} from './provider-direct-policy';
import {snapshotDirectJson} from './provider-direct-schema';
import {SUPABASE_CATALOG_SLUG} from './provider-report-action';
import {ConnectorError,type ConnectorContext} from './types';

// Choose the contract before reading provider data. Neither a failed dispatch
// nor an upstream 403 can select another credential, tool or analytics scope.
export function createInstanceConnectorDispatcher<D,R>(resolve:ConnectorContextResolver,interactive:(ctx:ConnectorContext)=>ConnectorContext,
  generic:{search:typeof searchDirectTools;describe:(name:string)=>Promise<D>;call:(name:string,input:unknown)=>Promise<R>}) {
  async function scopedRuntime(connectorId:string) {
    const initial=interactive(await resolve());
    const binding=scopedReadResolver(resolve,initial,connectorId);
    const {createInstanceScopedRead}=await import('./instance-scoped-read');
    return createInstanceScopedRead(binding);
  }
  return {
    async search(filters:ConnectorFilters={}) {
      const ctx=interactive(await resolve());
      if(filters.connector_id!==undefined&&!z.string().uuid().safeParse(filters.connector_id).success) throw new ConnectorError('INVALID_FILTER','Invalid connector account filter.',400);
      if(ctx.connectorIdHint&&filters.connector_id&&ctx.connectorIdHint!==filters.connector_id) throw new ConnectorError('NOT_FOUND','This connection is not selected.',404);
      const narrow=filters.connector_id?{...ctx,connectorIdHint:filters.connector_id}:ctx;
      const targets=await instanceSearchTargets(narrow);
      return Array.isArray(targets)?generic.search(narrow,filters,targets):scopedReadPage(targets.binding,filters);
    },
    async describe(name:string) {
      const ref=parseConnectorToolRef(name);
      return ref.toolSlug===SUPABASE_CATALOG_SLUG ? (await scopedRuntime(ref.connectorId)).describe(name) : generic.describe(name);
    },
    async call(name:string,input:unknown) {
      let ref:ReturnType<typeof parseConnectorToolRef>;
      try {ref=parseConnectorToolRef(name);} catch(error) {
        if(error instanceof ConnectorError)Object.assign(error,{executed:false,effectStarted:false});
        throw error;
      }
      if(ref.toolSlug!==SUPABASE_CATALOG_SLUG)return generic.call(name,input);
      // Keep pre-dispatch errors identifiable; never label an error from the
      // scoped call itself "not sent" (it may already have reached the provider).
      let runtime:Awaited<ReturnType<typeof scopedRuntime>>,snapshot:unknown;
      try {snapshot=snapshotDirectJson(input);runtime=await scopedRuntime(ref.connectorId);} catch(error) {
        if(error instanceof ConnectorError)Object.assign(error,{executed:false,effectStarted:false});
        throw error;
      }
      return runtime.call(name,snapshot);
    },
  };
}