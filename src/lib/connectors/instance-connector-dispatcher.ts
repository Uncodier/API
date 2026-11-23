import {z} from 'zod';
import {parseConnectorToolRef, retiredReportRef} from './connector-ref';
import type {ConnectorFilters} from './connector-discovery-types';
import type {ConnectorContextResolver} from './host-context';
import type {searchDirectTools} from './provider-direct-discovery';
import {selectedCatalogAccount} from './selected-catalog-account';
import {listDirectAccounts} from './provider-direct-policy';
import {ConnectorError,type ConnectorContext} from './types';

// Discovery may browse metadata without an execution grant. Describe and call
// accept provider references only; neither has a fallback.
export function createInstanceConnectorDispatcher<D,R>(resolve:ConnectorContextResolver,interactive:(ctx:ConnectorContext)=>ConnectorContext,
  generic:{search:typeof searchDirectTools;describe:(name:string)=>Promise<D>;call:(name:string,input:unknown)=>Promise<R>}) {
  return {
    async search(filters:ConnectorFilters={}) {
      const {tool_origin:origin='provider', ...filter}=filters;
      if(origin!=='provider' || retiredReportRef(filter.query) || retiredReportRef(filter.catalog_query)) throw new ConnectorError('INVALID_FILTER','Use provider discovery.',400);
      const ctx=interactive(await resolve());
      if(filters.connector_id!==undefined&&!z.string().uuid().safeParse(filters.connector_id).success) throw new ConnectorError('INVALID_FILTER','Invalid connector account filter.',400);
      if(ctx.connectorIdHint&&filters.connector_id&&ctx.connectorIdHint!==filters.connector_id) throw new ConnectorError('NOT_FOUND','This connection is not selected.',404);
      const account=filter.connector_id??ctx.connectorIdHint;
      const narrow=account?{...ctx,connectorIdHint:account}:ctx;
      // Only a missing direct grant on an explicitly selected account can lead to metadata-only browsing.
      // A catalog-only target never grants execution.
      const targets=await listDirectAccounts(narrow).catch(async error=>{
        if(!account || !(error instanceof ConnectorError) || error.code!=='DIRECT_POLICY_REQUIRED')throw error;
        return [await selectedCatalogAccount(narrow,account,ctx.connectorIdHint===account)];
      });
      return generic.search(ctx,filter,targets);
    },
    async describe(name:string) {
      parseConnectorToolRef(name);
      return generic.describe(name);
    },
    async call(name:string,input:unknown) {
      try { parseConnectorToolRef(name); } catch (error) {
        if (error instanceof ConnectorError) Object.assign(error,{executed:false,effectStarted:false});
        throw error;
      }
      return generic.call(name,input);
    },
  };
}
