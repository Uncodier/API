import {randomUUID} from 'node:crypto';
import {discoverSupport} from '../support-runtime-discovery';
import {optionalGenericSupport} from '../support-generic-authority';
import {candidateWindow} from '../support-runtime-access';
import {getReviewedTool} from '../reviewed-tools';
import {listSelectedCatalogMetadata} from '../composio-tool-metadata';
import {loadConnectorCredential} from '../account-access';
import type {DirectAuthorizedConnector} from '../provider-direct-policy';
import {connectorFixture,providerFixture,secret} from './composio-fixtures';

jest.mock('../support-generic-authority',()=>({optionalGenericSupport:jest.fn()}));
jest.mock('../support-runtime-access',()=>({candidateWindow:jest.fn()}));
jest.mock('../account-access',()=>({loadConnectorCredential:jest.fn()}));
jest.mock('../composio-tool-metadata',()=>({TOOL_CATALOG_LIMIT:20,listSelectedCatalogMetadata:jest.fn()}));
const scope={audience:'member' as const,siteId:randomUUID(),userId:randomUUID(),agentId:randomUUID(),conversationId:randomUUID(),idempotencyKey:'turn'};
const reviewed=getReviewedTool('GMAIL_FETCH_EMAILS');
const ids:string[]=[randomUUID(),randomUUID()].sort();
const slugs=Array.from({length:14},(_,i)=>`GMAIL_LIST_RECORDS_${i}`);
const target=(id:string):DirectAuthorizedConnector=>{
  const connector={...connectorFixture(),id,site_id:scope.siteId},provider=providerFixture();
  return {connector,provider,policy:{allowed_tools:[...slugs,reviewed.slug,'GMAIL_RUN_CODE'],allowed_hosts:['assistant'],revision:1,tool_access_mode:'selected',require_approval:true},
    directProof:{attestationId:randomUUID(),directRevision:1,expiresAt:new Date(Date.now()+60000).toISOString(),siteId:scope.siteId,connectorId:id,
      providerId:provider.id,toolkitSlug:connector.toolkit_slug,projectId:provider.project_id,accountId:connector.provider_account_id,
      authConfigId:connector.auth_config_id,credentialRevision:provider.credential_revision,resourceBoundary:'sample'}};
};
const targets=ids.map(target),recheck=jest.fn(async()=>{});
const authority=jest.mocked(optionalGenericSupport),metadata=jest.mocked(listSelectedCatalogMetadata);
const run=(filter:Parameters<typeof discoverSupport>[1])=>discoverSupport(scope,filter,recheck);
beforeEach(()=>{
  jest.resetAllMocks();
  jest.mocked(candidateWindow).mockImplementation(async(_s,_after,exact)=>ids.filter(id=>!exact||id===exact).map(id=>({id})));
  authority.mockImplementation(async(_s,id)=>({target:targets[ids.indexOf(id)],releaseMemberResult:false}));
  metadata.mockImplementation(async(_c,_k,batch)=>({missing:false,items:batch.map(slug=>({slug,name:'Public action',description:'Public metadata',action_types:[]}))}));
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey:secret(),revision:targets[0].provider.credential_revision,source:'byok'});
});
it('lists generic accounts once without reading catalog metadata',async()=>{
  const page=await run({action:'list'});
  expect(page).toMatchObject({connectors:ids.map(id=>({connector_id:id,account_label:`Account …${id.slice(-8)}`})),next_cursor:null});
  expect(metadata).not.toHaveBeenCalled();expect(JSON.stringify(page)).not.toContain(targets[0].connector.display_name);
});
it('pages through all selected tools and accounts without restricting executable capabilities by name',async()=>{
  const names:string[]=[];
  let cursor:string|undefined;
  for(let i=0;i<20;i++) {
    const page=await run({action:'search',query:'gmail',cursor});
    if(!('tools' in page)||!page.tools) throw new Error('Expected tools');
    expect(page.tools.length).toBeLessThanOrEqual(5);
    for(const tool of page.tools) expect(tool).toMatchObject({availability:'describe_required'});
    names.push(...page.tools.map(tool=>tool.name!));
    if(!page.next_cursor) break;
    cursor=page.next_cursor;expect(cursor.length).toBeLessThanOrEqual(128);
  }
  expect(names.sort()).toEqual(ids.flatMap(id=>[reviewed.slug,...slugs,'GMAIL_RUN_CODE'].map(s=>`connector:${id}:${s}`)).sort());
});
it('narrows qualified search by full local account ID, without falling back to another account',async()=>{
  const name=`connector:${ids[1]}:${slugs[5]}`;
  expect(await run({action:'search',query:name})).toMatchObject({tools:[{name}],next_cursor:null});
  expect(authority.mock.calls.map(call=>call[1])).toEqual([ids[1]]);
  expect(await run({action:'search',query:name,connector_id:ids[0]})).toMatchObject({tools:[],next_cursor:null});
});
it('binds direct cursors to the turn and selected account, and reloads authority before every page',async()=>{
  const filter={action:'list' as const,connector_id:ids[1]};
  const first=await run(filter);const cursor=first.next_cursor!;
  expect(cursor).toBeTruthy();
  await expect(run({...filter,connector_id:ids[0],cursor})).rejects.toMatchObject({code:'STALE_CURSOR'});
  await expect(discoverSupport({...scope,idempotencyKey:'new'}, {...filter,cursor},recheck)).rejects.toMatchObject({code:'STALE_CURSOR'});
  authority.mockResolvedValue(null);
  await expect(run({...filter,cursor})).rejects.toMatchObject({code:'STALE_CURSOR'});
  expect(metadata).toHaveBeenCalledTimes(1);
});
it.each(['anonymous','verified'] as const)('never reads generic authority or catalog for %s',async audience=>{
  const common={siteId:scope.siteId,agentId:scope.agentId,conversationId:scope.conversationId,idempotencyKey:'public'};
  expect(await discoverSupport(audience==='anonymous'?{...common,audience}:{...common,audience,leadId:randomUUID()},{action:'list'},recheck)).toEqual({success:false,status:'unavailable'});
  expect(candidateWindow).not.toHaveBeenCalled();expect(authority).not.toHaveBeenCalled();expect(metadata).not.toHaveBeenCalled();
});

it('stops a failed catalog lookup instead of continuing with another account', async () => {
  metadata.mockResolvedValue({missing:true, items:[]});
  await expect(run({action:'search',query:'gmail'})).rejects.toMatchObject({code:'SUPPORT_UNAVAILABLE'});
  expect(metadata).toHaveBeenCalledTimes(1);
});
