import { randomBytes, randomUUID } from 'node:crypto';
import { openPrivateReport } from '../private-report-choice';
import { requireConnectorActor } from '../http';
import { reviewerClient } from '../approval-context';
import { createConnectorRuntime } from '../runtime';
import { assistantConnectorContext } from '../host-context';
import { ConnectorError } from '../types';

jest.mock('../http', () => ({ requireConnectorActor: jest.fn() }));
jest.mock('../approval-context', () => ({ reviewerClient: jest.fn() }));
jest.mock('../runtime', () => ({ createConnectorRuntime: jest.fn() }));
jest.mock('../host-context', () => ({ assistantConnectorContext: jest.fn() }));
const id=randomUUID(), next=randomUUID(), user=randomUUID(), secret=randomBytes(24).toString('hex');
const row={site_id:randomUUID(),user_id:user,instance_id:randomUUID(),agent_id:randomUUID(),connector_id:randomUUID(),
  version:'v1',schema_hash:randomBytes(32).toString('hex'),arguments:{view:'sales_private'}};
const rpc=jest.fn(), call=jest.fn();
const req=(value:unknown={choice:0})=>new Request('https://api.example.test/api/connectors/private-results/'+id+'/open',{
  method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${secret}`},body:JSON.stringify(value)});
const result=(data:unknown)=>({abortSignal:async()=>({data,error:null})});
beforeEach(()=>{
  jest.resetAllMocks(); jest.mocked(requireConnectorActor).mockResolvedValue(user); jest.mocked(reviewerClient).mockReturnValue({rpc} as any);
  rpc.mockReturnValue(result(row)); jest.mocked(assistantConnectorContext).mockImplementation(scope=>async()=>scope as any);
  jest.mocked(createConnectorRuntime).mockImplementation(resolve=>({call:async(...args:any[])=>{await resolve(); return call(...args);}} as any));
  call.mockResolvedValue({success:true,receipt:{status:'private_result_ready',url:`/connectors/results/${next}`}});
});
it('executes only the authenticated choice using the owner, account, agent, original pins and arguments read from storage',async()=>{
  const response=await openPrivateReport(req(),id); expect(response.status).toBe(200); expect(await response.json()).toEqual({id:next});
  expect(rpc.mock.calls).toEqual(Array(2).fill(['connector_private_report_choice',{p_id:id,p_choice:0}]));
  expect(assistantConnectorContext).toHaveBeenCalledWith({siteId:row.site_id,userId:user,agentId:row.agent_id,instanceId:row.instance_id,
    host:'assistant',connectorIdHint:row.connector_id,catalogUserSession:true});
  expect(call).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledWith(`connector:${row.connector_id}:SUPABASE_RUN_READ_ONLY_QUERY`,
    {arguments:row.arguments,version:row.version,schema_hash:row.schema_hash});
});
it('does not accept report data, pin, SQL, scope, cursor, anonymous or cross-user identity from a client',async()=>{
  for(const extra of [{site_id:row.site_id},{instance_id:row.instance_id},{after:'sales_private'},{query:'SELECT 1'},{connector_id:row.connector_id}]){
    expect((await openPrivateReport(req({choice:0,...extra}),id)).status).toBe(400);
  }
  expect((await openPrivateReport(req({choice:25}),id)).status).toBe(400); expect((await openPrivateReport(req(),'invalid')).status).toBe(400);
  jest.mocked(requireConnectorActor).mockRejectedValueOnce(new ConnectorError('UNAUTHORIZED','Unauthorized',401)); expect((await openPrivateReport(req(),id)).status).toBe(401);
  expect(rpc).not.toHaveBeenCalled(); for(const bad of [null,{...row,user_id:randomUUID()},{...row,arguments:{query:'SELECT 1'}},{...row,arguments:{view:'bad;'}}]) {
    rpc.mockReturnValueOnce(result(bad)); expect((await openPrivateReport(req(),id)).status).toBe(404);
  }
  expect(call).not.toHaveBeenCalled();
});
it('rechecks expiry/revocation before dispatch and refuses unconfirmed or raw service responses',async()=>{
  rpc.mockReturnValueOnce(result(row)).mockReturnValueOnce(result(null)); expect((await openPrivateReport(req(),id)).status).toBe(404);
  expect(call).not.toHaveBeenCalled(); rpc.mockReturnValue(result({...row,arguments:{after:'sales_private'}}));
  for (const reply of [{result:secret},{receipt:{status:'private_result_ready',url:'https://other.example.test'}}]) {
    call.mockResolvedValueOnce(reply); const response=await openPrivateReport(req({choice:-1}),id);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(secret);
  }
  expect(call).toHaveBeenLastCalledWith(expect.any(String),expect.objectContaining({arguments:{after:'sales_private'}}));
});
