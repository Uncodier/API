import { randomBytes, randomUUID } from 'node:crypto';
import { GET as housekeeping } from '@/app/api/cron/maintenance/sandbox-housekeeping/route';
import { requirementStatusReferences, housekeepingRows } from '../sandbox-housekeeping-db';
import { listHousekeepingSandboxes } from '../sandbox-housekeeping-list';
import { Sandbox } from '@vercel/sandbox';
import { ensureWorkflowSandbox, stopWorkflowSandbox } from '@/lib/services/workflow-robot/sandbox-workspace';
import { workflowSandboxName } from '@/lib/services/workflow-robot/workspace-identity';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSandboxHandle } from '@/lib/services/sandbox-sdk';
import { stopSandboxQuiet } from '@/lib/services/sandbox-stop';
import { registerSandboxBilling, reconcileSandboxBilling, SandboxBillingError } from '../sandbox-billing';
jest.mock('../sandbox-housekeeping-db', () => ({ requirementStatusReferences: jest.fn(), housekeepingRows: jest.fn() }));
jest.mock('../sandbox-housekeeping-list', () => ({ listHousekeepingSandboxes: jest.fn() }));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn() }));
jest.mock('@vercel/sandbox',()=>({Sandbox:{get:jest.fn(),create:jest.fn()}}));
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{from:jest.fn()}}));
jest.mock('@/lib/services/sandbox-sdk',()=>({sandboxSdkMajor:()=>3,getSandboxHandle:jest.fn(),sandboxIdentity:(s:{name:string})=>s.name}));
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

it('preserves a workflow that resumes its stored VM after housekeeping read the inactive plan', async () => {
  const name = workflowSandboxName(runPlanId);
  plan.metadata.active_sandbox_id = name;
  let status = 'completed';
  jest.mocked(requirementStatusReferences).mockResolvedValue({ activeSandboxIds: new Set(), activeSnapshotIds: new Set() });
  jest.mocked(housekeepingRows).mockImplementation(async table => table === 'instance_plans'
    ? [{ status, metadata: { ...plan.metadata } }]
    : table === 'sandbox_billing_resources' ? [{ sandbox_name: name }] : []);
  let inventoryStarted!: () => void, releaseInventory!: () => void;
  const started = new Promise<void>(resolve => { inventoryStarted = resolve; });
  const hold = new Promise<void>(resolve => { releaseInventory = resolve; });
  jest.mocked(listHousekeepingSandboxes).mockImplementationOnce(async () => {
    inventoryStarted(); await hold;
    return [{ id: name, createdAt: Date.now() - 3600000 }];
  });
  const vm = { name, status: 'stopped', delete: jest.fn() };
  jest.mocked(getSandboxHandle).mockResolvedValue(vm as never);
  jest.mocked(Sandbox.get).mockImplementation(async opts => {
    if (opts.resume) vm.status = 'running';
    return vm as never;
  });
  const env = { CRON_SECRET: randomBytes(24).toString('hex'), VERCEL: '1' };
  const original = { CRON_SECRET: process.env.CRON_SECRET, VERCEL: process.env.VERCEL };
  Object.assign(process.env, env);
  try {
    const sweep = housekeeping(new Request('https://api.example.test/cron', {headers: {authorization: `Bearer ${env.CRON_SECRET}`}}));
    await started;
    status = 'running';
    const attached = await ensureWorkflowSandbox({runPlanId, siteId, instanceId});
    expect(attached.sandboxId).toBe(name); expect(vm.status).toBe('running');
    releaseInventory();
    expect((await (await sweep).json()).results).toMatchObject({unfencedSandboxCandidates: 1, sandboxesBilled: 1});
    expect(stopSandboxQuiet).not.toHaveBeenCalled(); expect(vm.delete).not.toHaveBeenCalled();
  } finally {
    releaseInventory();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
