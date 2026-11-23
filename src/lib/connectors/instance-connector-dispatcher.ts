import {z} from 'zod';
import {parseInstanceToolRef} from './instance-tool-ref';
import type {ConnectorFilters} from './connector-discovery-types';
import type {ConnectorContextResolver} from './host-context';
import {scopedReadPage,scopedReadResolver} from './instance-scoped-binding';
import type {searchDirectTools} from './provider-direct-discovery';
import {listDirectAccounts} from './provider-direct-policy';
import {snapshotDirectJson} from './provider-direct-schema';
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
      const {tool_origin:origin='provider', ...filter}=filters;
      if(origin!=='provider'&&origin!=='makinari_report') throw new ConnectorError('INVALID_FILTER','Choose provider or makinari_report.',400);
      const ctx=interactive(await resolve());
      if(filters.connector_id!==undefined&&!z.string().uuid().safeParse(filters.connector_id).success) throw new ConnectorError('INVALID_FILTER','Invalid connector account filter.',400);
      if(ctx.connectorIdHint&&filters.connector_id&&ctx.connectorIdHint!==filters.connector_id) throw new ConnectorError('NOT_FOUND','This connection is not selected.',404);
      const account=filter.connector_id??ctx.connectorIdHint;
      if(origin==='makinari_report') {
        if(!account)throw new ConnectorError('REPORT_ACCOUNT_REQUIRED','Select the connection for this internal report.',400);
        return scopedReadPage(await scopedReadResolver(resolve,ctx,account)(),filter);
      }
      const narrow=account?{...ctx,connectorIdHint:account}:ctx;
      return generic.search(narrow,filter,await listDirectAccounts(narrow));
    },
    async describe(name:string) {
      const ref=parseInstanceToolRef(name);
      return ref.origin==='makinari_report' ? (await scopedRuntime(ref.connectorId)).describe(name) : generic.describe(name);
    },
    async call(name:string,input:unknown) {
      let ref:ReturnType<typeof parseInstanceToolRef>;
      try {ref=parseInstanceToolRef(name);} catch(error) {
        if(error instanceof ConnectorError)Object.assign(error,{executed:false,effectStarted:false});
        throw error;
      }
      if(ref.origin==='provider')return generic.call(name,input);
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