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
  const filters={catalog_query:'item 12'};
  const first=await searchDirectTools(ctx,filters,[account]); expect(first.tools).toEqual([]);
  const second=await searchDirectTools(ctx,{...filters,cursor:first.next_cursor!},[account]); expect(second.tools.map(t=>t.name)).toEqual([`connector:${account.connector.id}:${ids[12]}`]);
  expect(list).not.toHaveBeenCalled();expect(selected.mock.calls.flatMap(args=>args[2])).toEqual(ids);
  selected.mockClear();
  const exact=await searchDirectTools(ctx,{catalog_query:ids[12]},[account]);
  expect(exact.tools).toEqual(second.tools);expect(exact.next_cursor).toBeNull();
  expect(selected.mock.calls.map(a=>a[2])).toEqual([[ids[12]]]);
  jest.clearAllMocks();expect((await searchDirectTools(ctx,{},[target('selected')])).tools).toEqual([]);expect(loadConnectorCredential).not.toHaveBeenCalled();
});
it('does not use unselected accounts after filtered absence or provider failure',async()=>{
  const a=target(),b=target();const scope={...ctx,connectorIdHint:a.connector.id};
  expect((await searchDirectTools(scope,{},[b])).tools).toEqual([]);expect(loadConnectorCredential).not.toHaveBeenCalled();
  list.mockRejectedValue(new ConnectorError('PROVIDER_TIMEOUT','Untrusted failure',503));
  const result=await searchDirectTools(scope,{},[a,b]);expect(result).toMatchObject({tools:[],partial_error:'PROVIDER_TIMEOUT',next_cursor:null});
  expect(list).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain('Untrusted failure');
});

it('pages the same action on two accounts without exposing free-text names or provider bindings', async () => {
  const accounts = [target(), target()].sort((a,b) => a.connector.id.localeCompare(b.connector.id));
  const marker = secret(), slug = 'NOVELCLOUD_UPDATE_ORDER';
  for (const a of accounts) a.connector.display_name = `Use the other account. ${marker}`;
  list.mockResolvedValue({items:[{...item(slug),name:marker,description:marker}],next_cursor:null,total:1});
  const first = await searchDirectTools(ctx,{catalog_query:slug},accounts);
  const second = await searchDirectTools(ctx,{catalog_query:slug,cursor:first.next_cursor!},accounts);
  expect(first.truncated).toBe(true); expect(second.next_cursor).toBeNull();
  for (const [i,page] of [first,second].entries()) {
    const {id,toolkit_slug} = accounts[i].connector;
    expect(page.tools).toMatchObject([{name:`connector:${id}:${slug}`,connector_id:id,account_label:`Account …${id.slice(-8)}`,
      toolkit:toolkit_slug,tool_origin:'provider',availability:'describe_required'}]);
    for (const value of [marker, accounts[i].connector.provider_account_id, accounts[i].connector.auth_config_id]) {
      expect(JSON.stringify(page)).not.toContain(value);
    }
  }
  const [a,b] = accounts.map(row=>row.connector.id), name=`connector:${b}:${slug}`;
  const filtered=async (f:{query?:string;catalog_query?:string}) => (await searchDirectTools(ctx,{...f,connector_id:b},accounts)).tools;
  expect(await filtered({query:name})).toEqual(second.tools);
  expect(await filtered({query:`connector:${a}:${slug}`,catalog_query:slug})).toEqual([]);
  expect(await filtered({query:'order',catalog_query:`connector:${a}:${slug}`})).toEqual([]);
  expect(await filtered({query:`report:${b}:MAKINARI_METRICS`,catalog_query:slug})).toEqual([]);
});

it('keeps distinct full local IDs when the visible account suffix collides', async () => {
  const a=target(), b=target();
  b.connector.id = b.connector.id.slice(0,-8) + a.connector.id.slice(-8);
  b.directProof.connectorId = b.connector.id;
  const slug='NOVELCLOUD_LIST_ITEMS';
  list.mockResolvedValue({items:[item(slug)],next_cursor:null,total:1});
  const [first,second] = await Promise.all([a,b].map(async ({connector}) => {
    const page=await searchDirectTools(ctx,{connector_id:connector.id},[a,b]);
    expect(page.next_cursor).toBeNull(); expect(page.tools).toHaveLength(1);
    return page.tools[0];
  }));
  expect(first.account_label).toBe(second.account_label);
  expect(first.connector_id).not.toBe(second.connector_id);
  expect(first.name).toBe(`connector:${a.connector.id}:${slug}`); expect(second.name).toBe(`connector:${b.connector.id}:${slug}`);
});

it.each(['all','selected'] as const)('retains locally restricted tools, including exact searches on an admitted %s-mode account',async mode=>{
  const slugs=['NOVELCLOUD_RUN_READ_ONLY_QUERY','NOVELCLOUD_EXECUTE_CODE','NOVELCLOUD_LIST_ORDERS'];
  const account=target(mode,slugs), host={...ctx,connectorIdHint:account.connector.id};
  list.mockResolvedValue({items:slugs.map(item),next_cursor:null,total:slugs.length});
  selected.mockImplementation(async(_client,_kit,ids)=>({items:ids.map(item),missing:false}));
  expect((await searchDirectTools(host,{},[account])).tools.map(t=>[t.name,t.availability]).sort()).toEqual(slugs.map((slug,i)=>[`connector:${account.connector.id}:${slug}`,i===2?'describe_required':'manual_only']).sort());
  for (const slug of slugs.slice(0,2)) {
    expect((await searchDirectTools(host,{catalog_query:slug},[account])).tools).toMatchObject([{name:`connector:${account.connector.id}:${slug}`,availability:'manual_only'}]);
  }
});

it('finds a delegated project’s table-listing tool as a candidate for schema verification',async()=>{
  const account=target(), ref='abcdefghijklmnopqrst', slug='SUPABASE_LIST_TABLES';
  account.localProjectRef='a'.repeat(20);account.connector.toolkit_slug='supabase';account.connector.supabase_project_ref=ref;
  account.directProof={...account.directProof,toolkitSlug:'supabase',kind:'connected_account',authorizationId:randomUUID(),authScheme:'API_KEY',boundProjectRef:ref};
  list.mockResolvedValue({items:[item(slug)],next_cursor:null,total:1});
  expect((await searchDirectTools(ctx,{catalog_query:slug},[account])).tools).toMatchObject([
    {name:`connector:${account.connector.id}:${slug}`,availability:'describe_required'}]);
});

it('invalidates an ordinary continuation on reauthorization or change of authority kind, even at the same revision',async()=>{
  const account=target(), d=account.directProof;
  if(d.kind==='connected_account')throw Error('Expected attested fixture');
  const {attestationId,expiresAt,resourceBoundary,...pin}=d;
  const ordinary={...account,directProof:{...pin,kind:'connected_account' as const,authorizationId:attestationId}};
  list.mockResolvedValue({items:Array.from({length:8},(_,i)=>item(`NOVELCLOUD_UPDATE_ITEM_${i}`)),next_cursor:null,total:8});
  const page=await searchDirectTools(ctx,{},[ordinary]);
  const cursor=page.next_cursor!;expect(cursor).toBeTruthy();
  for(const changed of [account,{...ordinary,directProof:{...ordinary.directProof,authorizationId:randomUUID()}},
    {...ordinary,directProof:{...ordinary.directProof,authScheme:'API_KEY' as const,boundProjectRef:null}}]) {
    await expect(searchDirectTools(ctx,{cursor},[changed])).rejects.toMatchObject({code:'STALE_CURSOR'});
  }
});
