import { randomBytes, randomUUID } from 'node:crypto';
import { POST } from '../route';
import { ConnectorError } from '@/lib/connectors/types';
import { describeWorkflowOperation } from '@/lib/connectors/workflow-read-descriptor';

const getUser = jest.fn(), access = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({supabaseAdmin:{auth:{getUser:(...args:unknown[])=>getUser(...args)}}}));
jest.mock('@/lib/connectors/access', () => ({requireConnectorSiteAccess:(...args:unknown[])=>access(...args)}));
jest.mock('@/lib/connectors/workflow-read-descriptor', () => ({...jest.requireActual('@/lib/connectors/workflow-read-descriptor'),describeWorkflowOperation:jest.fn()}));
const service=jest.mocked(describeWorkflowOperation), site=randomUUID(), user=randomUUID(), id=randomUUID();
const body={site_id:site,connector_id:id,tool_slug:'ORBITAL_LIST_STAGES'};
const descriptor={connector_id:id,toolkit_slug:'orbital',tool_slug:body.tool_slug,toolkit_version:'20261119_00',
  schema_hash:randomBytes(32).toString('hex'),input_schema:{type:'object',properties:{limit:{type:'integer'}}}};
const token=randomBytes(32).toString('base64url');
const request=(input:unknown=body, auth=true, query='',type='application/json')=> new Request('https://api.example.test/api/connectors/workflow-operation'+query,{
  method:'POST',body:JSON.stringify(input),headers:{'content-type':type,...(auth&&{authorization:`Bearer ${token}`})}});
beforeEach(()=>{jest.resetAllMocks(); getUser.mockResolvedValue({data:{user:{id:user}},error:null}); access.mockResolvedValue({can_manage:true}); service.mockResolvedValue(descriptor);});
it.each([{}, {arguments:{limit:1}}])('describes and validates only for a bearer-authenticated manager %j',async extra=>{
  const req=request({...body,...extra}); const response=await POST(req);
  expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual(descriptor);expect(access).toHaveBeenCalledWith(site,user,true);
  expect(service).toHaveBeenCalledWith(user,{...body,...extra});
});
it('does not describe for an anonymous caller or a non-manager',async()=>{
  expect((await POST(request(body,false))).status).toBe(401);expect(access).not.toHaveBeenCalled();
  access.mockRejectedValue(new ConnectorError('ACCESS_DENIED','Access denied.',403));
  expect((await POST(request())).status).toBe(403);expect(service).not.toHaveBeenCalled();
});
it.each([{toolkit_version:'20261120_00'},{schema_hash:descriptor.schema_hash},{principal_id:user},{toolkit_slug:'arbitrary'},{arguments:[]},
  {arguments:null},{connector_id:'invalid'},{site_id:'bad'},{tool_slug:'COMPOSIO_PROXY'},{tool_slug:'https://bad.example.test'}])('rejects untrusted inputs %j',async patch=>{
  expect((await POST(request({...body,...patch}))).status).toBe(400);expect(service).not.toHaveBeenCalled();
});
it('rejects query overrides, non-JSON and oversize inputs',async()=>{
  expect((await POST(request(body,true,'?version=latest'))).status).toBe(400);
  expect((await POST(request(body,true,'','text/plain'))).status).toBe(415);
  expect((await POST(request({...body,arguments:{text:'A'.repeat(50_000)}}))).status).toBe(413);expect(service).not.toHaveBeenCalled();
});
