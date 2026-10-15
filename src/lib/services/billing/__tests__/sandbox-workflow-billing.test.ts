import { randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { ensureWorkflowSandbox, stopWorkflowSandbox } from '@/lib/services/workflow-robot/sandbox-workspace';
import { workflowSandboxName } from '@/lib/services/workflow-robot/workspace-identity';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSandboxHandle } from '@/lib/services/sandbox-sdk';
import { stopSandboxQuiet } from '@/lib/services/sandbox-stop';
import { registerSandboxBilling, reconcileSandboxBilling, SandboxBillingError } from '../sandbox-billing';
jest.mock('@vercel/sandbox',()=>({Sandbox:{get:jest.fn(),create:jest.fn()}}));
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{from:jest.fn()}}));
jest.mock('@/lib/services/sandbox-sdk',()=>({getSandboxHandle:jest.fn(),sandboxIdentity:(s:{name:string})=>s.name}));
jest.mock('@/lib/services/sandbox-stop',()=>({stopSandboxQuiet:jest.fn()}));
jest.mock('@/lib/services/sandbox-missing-snapshot',()=>({isSandboxNotFoundError:(error:any)=>error?.response?.status===404}));
jest.mock('@/lib/services/sandbox-create-params',()=>({buildSandboxCreateParams:(p:unknown)=>p}));
jest.mock('@/app/api/agents/tools/sandbox/assistantProtocol',()=>({getSandboxTools:jest.fn(()=>[])}));
jest.mock('@/lib/services/workflow-robot/browser',()=>({ensureWorkflowBrowserReady:jest.fn()}));
jest.mock('../sandbox-billing',()=>({registerSandboxBilling:jest.fn(),reconcileSandboxBilling:jest.fn(),SandboxBillingError:class extends Error {}}));
const runPlanId=randomUUID(),siteId=randomUUID(),instanceId=randomUUID();
let plan:{site_id:string;instance_id:string;metadata:Record<string,string>};
const query=()=>{const q:any={}; for(const method of ['select','eq','update'])q[method]=jest.fn(()=>q);
  q.single=jest.fn(async()=>({data:q.table==='instance_plans'?plan:{environment_variables:{}},error:null}));
  q.then=(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:null,error:null}).then(resolve);return q;};
beforeEach(()=>{jest.resetAllMocks();plan={site_id:siteId,instance_id:instanceId,metadata:{}};
  jest.mocked(supabaseAdmin.from).mockImplementation(((table:string)=>{const q=query();q.table=table;return q;}) as never);});
it('registers canonical name before provider create, bills before persistence/tool use',async()=>{
  const sandbox={name:workflowSandboxName(runPlanId)};jest.mocked(Sandbox.create).mockResolvedValue(sandbox as never);
  const result=await ensureWorkflowSandbox({runPlanId,siteId,instanceId});
  expect(result.sandboxId).toBe(sandbox.name);
  expect(registerSandboxBilling).toHaveBeenCalledWith(sandbox.name,{kind:'workflow',id:runPlanId,siteId});
  expect(jest.mocked(registerSandboxBilling).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(Sandbox.create).mock.invocationCallOrder[0]);
  expect(reconcileSandboxBilling).toHaveBeenCalledWith(sandbox);
});
it('registers canonical replacement name when old persisted provider ID is missing',async()=>{
  plan.metadata.active_sandbox_id='historical-id';jest.mocked(getSandboxHandle).mockRejectedValue({response:{status:404}});
  jest.mocked(Sandbox.create).mockResolvedValue({name:workflowSandboxName(runPlanId)} as never);
  await ensureWorkflowSandbox({runPlanId});
  expect(registerSandboxBilling).toHaveBeenCalledWith('historical-id',{kind:'workflow',id:runPlanId,siteId});
  expect(registerSandboxBilling).toHaveBeenCalledWith(workflowSandboxName(runPlanId),{kind:'workflow',id:runPlanId,siteId});
});
it('rejects forged site/instance scope before provider use',async()=>{
  await expect(ensureWorkflowSandbox({runPlanId,siteId:randomUUID()})).rejects.toThrow('scope mismatch');
  expect(Sandbox.create).not.toHaveBeenCalled();expect(getSandboxHandle).not.toHaveBeenCalled();
});
it('billing outage on recovery stops VM and never falls through to replacement',async()=>{
  plan.metadata.active_sandbox_id='existing';const sandbox={name:'existing'};
  jest.mocked(getSandboxHandle).mockResolvedValue(sandbox as never);
  jest.mocked(reconcileSandboxBilling).mockRejectedValue(new SandboxBillingError());
  await expect(ensureWorkflowSandbox({runPlanId})).rejects.toThrow();
  expect(stopSandboxQuiet).toHaveBeenCalledWith(sandbox);expect(Sandbox.create).not.toHaveBeenCalled();expect(Sandbox.get).not.toHaveBeenCalled();
});
it('workflow stop uses shared final-timestamp billing cleanup',async()=>{
  const sandbox={name:'existing'};jest.mocked(getSandboxHandle).mockResolvedValue(sandbox as never);
  await stopWorkflowSandbox(sandbox.name);expect(stopSandboxQuiet).toHaveBeenCalledWith(sandbox);
});