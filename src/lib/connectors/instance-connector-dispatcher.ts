import {z} from 'zod';
import {parseConnectorToolRef, retiredReportRef} from './connector-ref';
import type {ConnectorFilters} from './connector-discovery-types';
import type {ConnectorContextResolver} from './host-context';
import type {searchDirectTools} from './provider-direct-discovery';
import {listDirectAccounts} from './provider-direct-policy';
import {ConnectorError,type ConnectorContext} from './types';

// All operations use direct authority on the selected provider account.
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
      return generic.search(narrow,filter,await listDirectAccounts(narrow));
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
