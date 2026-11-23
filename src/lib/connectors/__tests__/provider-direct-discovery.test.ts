import {randomUUID} from 'node:crypto';
import {searchDirectTools} from '../provider-direct-discovery';
import {loadConnectorCredential} from '../account-access';
import {listToolkitToolMetadata,listSelectedCatalogMetadata} from '../composio-tool-metadata';
import {connectorFixture,providerFixture,secret} from './composio-fixtures';
import type {DirectAuthorizedConnector} from '../provider-direct-policy';
import {ConnectorError, type ConnectorContext} from '../types';

jest.mock('../account-access',()=>({loadConnectorCredential:jest.fn()}));
jest.mock('../composio-tool-metadata',()=>({TOOL_CATALOG_LIMIT:20,listToolkitToolMetadata:jest.fn(),listSelectedCatalogMetadata:jest.fn()}));
const ctx:ConnectorContext={siteId:randomUUID(),userId:randomUUID(),agentId:randomUUID(),instanceId:randomUUID(),host:'assistant',catalogUserSession:true};
const list=jest.mocked(listToolkitToolMetadata),selected=jest.mocked(listSelectedCatalogMetadata);
const item=(slug:string)=>({slug,name:'Public catalog name',description:'Public metadata only',action_types:['update'] as ['update']});
function target(mode:'all'|'selected'='all', allowed_tools:string[]=[]):DirectAuthorizedConnector {
  const c={...connectorFixture(),id:randomUUID(),site_id:ctx.siteId,toolkit_slug:'novelcloud'};
  const p={...providerFixture(),site_id:ctx.siteId,provider_user_id:ctx.siteId};
  return {connector:c,provider:p,policy:{revision:1,tool_access_mode:mode,allowed_tools,allowed_hosts:['assistant'],require_approval:false},
    directProof:{attestationId:randomUUID(),directRevision:3,expiresAt:new Date(Date.now()+60000).toISOString(),siteId:ctx.siteId,connectorId:c.id,providerId:p.id,
      projectId:p.project_id,accountId:c.provider_account_id,authConfigId:c.auth_config_id,credentialRevision:p.credential_revision,toolkitSlug:c.toolkit_slug,resourceBoundary:'example-resource'}};
}
beforeEach(()=>{jest.resetAllMocks();jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey:secret(),revision:providerFixture().credential_revision,source:'byok'});});
it('discovers new tools including writes on a cloud-branded toolkit and does not send prompt text to Composio',async()=>{
  const account=target(); const items=Array.from({length:8},(_,i)=>item(`NOVELCLOUD_UPDATE_ITEM_${i}`));
  list.mockResolvedValue({items,next_cursor:null,total:8});
  const filters={query:'update secret customer phrase'};
  const first=await searchDirectTools(ctx,filters,[account]);
  expect(first.tools).toHaveLength(5);
  expect(first.tools.every(row=>row.availability==='describe_required' && row.connector_id===account.connector.id)).toBe(true);
  const second=await searchDirectTools(ctx,{...filters,cursor:first.next_cursor!},[account]);
  expect(second.tools).toHaveLength(3);expect(second.next_cursor).toBeNull();expect(selected).not.toHaveBeenCalled();
  expect(list.mock.calls.map(args=>args.slice(1))).toEqual([['novelcloud',undefined],['novelcloud',undefined]]);
  await expect(searchDirectTools(ctx,{...filters,cursor:first.next_cursor!},[{...account,directProof:{...account.directProof,directRevision:5}}])).rejects.toMatchObject({code:'STALE_CURSOR'});
  await expect(searchDirectTools(ctx,{...filters,cursor:first.next_cursor!},[{...account,policy:{...account.policy,revision:2}}])).rejects.toMatchObject({code:'STALE_CURSOR'});
});
it('uses only saved selected IDs, including with a cursor on an empty page; an empty policy does not access credentials',async()=>{
  const ids=Array.from({length:13},(_,i)=>`NOVELCLOUD_ITEM_${String(i).padStart(2,'0')}`);
  const account=target('selected',ids); selected.mockImplementation(async(_c,_k,ids)=>({items:ids.map(item),missing:false}));
  const filters={catalog_query:'NOVELCLOUD_ITEM_12'};
  const first=await searchDirectTools(ctx,filters,[account]); expect(first.tools).toEqual([]);
  const second=await searchDirectTools(ctx,{...filters,cursor:first.next_cursor!},[account]); expect(second.tools.map(t=>t.name)).toEqual([`connector:${account.connector.id}:${ids[12]}`]);
  expect(list).not.toHaveBeenCalled();expect(selected.mock.calls.flatMap(args=>args[2])).toEqual(ids);
  jest.clearAllMocks();expect((await searchDirectTools(ctx,{},[target('selected')])).tools).toEqual([]);expect(loadConnectorCredential).not.toHaveBeenCalled();
});
it('does not use unselected accounts after filtered absence or provider failure',async()=>{
  const a=target(),b=target();const scope={...ctx,connectorIdHint:a.connector.id};
  expect((await searchDirectTools(scope,{},[b])).tools).toEqual([]);expect(loadConnectorCredential).not.toHaveBeenCalled();
  list.mockRejectedValue(new ConnectorError('PROVIDER_TIMEOUT','Untrusted failure',503));
  const result=await searchDirectTools(scope,{},[a,b]);expect(result).toMatchObject({tools:[],partial_error:'PROVIDER_TIMEOUT',next_cursor:null});
  expect(list).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain('Untrusted failure');
});