import { randomBytes, randomUUID } from 'node:crypto';
import { GET } from '@/app/api/cron/maintenance/sandbox-housekeeping/route';
import { sandboxSdkMajor } from '@/lib/services/sandbox-sdk';
import { Sandbox } from '@vercel/sandbox';
import { housekeepingRows, requirementStatusReferences } from '../sandbox-housekeeping-db';
import { listHousekeepingSandboxes } from '../sandbox-housekeeping-list';
import { reconcileSandboxBilling, retireSandboxBilling, SandboxBillingError } from '../sandbox-billing';
import { stopSandboxQuiet } from '@/lib/services/sandbox-stop';
import { deleteSnapshotQuiet } from '@/lib/services/sandbox-persisted-snapshot';
import { isSandboxNotFoundError } from '@/lib/services/sandbox-missing-snapshot';
import { claimSandboxCleanup } from '../sandbox-cleanup-fence';
import { deleteSandboxAndOrphans } from '@/lib/services/sandbox-lifecycle';
jest.mock('../sandbox-cleanup-fence',()=>({claimSandboxCleanup:jest.fn()}));
jest.mock('@/lib/status/telemetry',()=>({recordTelemetry:jest.fn().mockResolvedValue(undefined)}));
jest.mock('@vercel/sandbox',()=>({Sandbox:{get:jest.fn(),listSnapshots:jest.fn()}}));
jest.mock('../sandbox-housekeeping-db',()=>({housekeepingRows:jest.fn(),requirementStatusReferences:jest.fn()}));
jest.mock('../sandbox-housekeeping-list',()=>({listHousekeepingSandboxes:jest.fn()}));
jest.mock('../sandbox-billing',()=>({...jest.requireActual('../sandbox-billing'),reconcileSandboxBilling:jest.fn(),retireSandboxBilling:jest.fn()}));
jest.mock('@/lib/services/sandbox-stop',()=>({stopSandboxQuiet:jest.fn()}));
jest.mock('@/lib/services/sandbox-persisted-snapshot',()=>({deleteSnapshotQuiet:jest.fn()}));
jest.mock('@/lib/services/sandbox-sdk',()=>({sandboxSdkMajor:jest.fn()}));
jest.mock('@/lib/services/sandbox-lifecycle',()=>({deleteSandboxAndOrphans:jest.fn()}));
jest.mock('@/lib/services/sandbox-missing-snapshot',()=>({isSandboxNotFoundError:jest.fn()}));
const credentials={CRON_SECRET:randomBytes(24).toString('hex'),VERCEL_TOKEN:randomBytes(24).toString('hex'),VERCEL_TEAM_ID:'synthetic-team',VERCEL_PROJECT_ID:'synthetic-project'};
let saved:Record<string,string|undefined>;
beforeEach(()=>{
  jest.mocked(sandboxSdkMajor).mockReturnValue(3);
  jest.clearAllMocks();jest.mocked(housekeepingRows).mockReset();jest.mocked(Sandbox.get).mockReset();
  jest.mocked(requirementStatusReferences).mockResolvedValue({activeSandboxIds:new Set(),activeSnapshotIds:new Set()});
  saved=Object.fromEntries([...Object.keys(credentials),'VERCEL'].map(key=>[key,process.env[key]]));
  Object.assign(process.env,credentials);delete process.env.VERCEL;
  jest.mocked(housekeepingRows).mockResolvedValue([]);jest.mocked(listHousekeepingSandboxes).mockResolvedValue([]);
  jest.mocked(isSandboxNotFoundError).mockReturnValue(false);
  jest.mocked(retireSandboxBilling).mockReset().mockResolvedValue(undefined);
  jest.mocked(reconcileSandboxBilling).mockReset().mockResolvedValue(undefined);
  jest.mocked(claimSandboxCleanup).mockReset().mockResolvedValue(null);
  jest.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Live network forbidden'));
});
afterEach(()=>{
  expect(globalThis.fetch).not.toHaveBeenCalled();jest.restoreAllMocks();
  for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
it('reconciles stopped/name-only tracked VM and preserves harness reference and snapshots without remote REST',async()=>{
  const name=`h-${randomUUID()}`,snapshot=randomUUID();
  jest.mocked(housekeepingRows).mockImplementation(async table=>table==='harness_sessions'?[{snapshot:{status:'paused',workspace:{id:name}}}]
    :table==='sandbox_billing_resources'?[{sandbox_name:name}]:[]);
  jest.mocked(listHousekeepingSandboxes).mockResolvedValue([{id:name,name,createdAt:Date.now()-3600000}]);
  const sandbox={name,status:'stopped',currentSnapshotId:snapshot};jest.mocked(Sandbox.get).mockResolvedValue(sandbox as never);
  const response=await GET(new Request('https://api.example.test/cron',{headers:{authorization:`Bearer ${credentials.CRON_SECRET}`}}));
  expect(response.status).toBe(200);expect((await response.json()).results.sandboxesBilled).toBe(1);
  expect(reconcileSandboxBilling).toHaveBeenCalledWith(sandbox);expect(stopSandboxQuiet).not.toHaveBeenCalled();expect(deleteSnapshotQuiet).not.toHaveBeenCalled();
  expect(Sandbox.get).toHaveBeenCalledWith(expect.objectContaining({name,resume:false}));
  expect(housekeepingRows).toHaveBeenCalledWith('sandbox_billing_resources','sandbox_name,deletion_requested_at','sandbox_name',undefined,true);
});

it('does not stop a live leased assistant inspection as an orphan', async () => {
  const name = `ai-${randomBytes(20).toString('hex')}`;
  jest.mocked(housekeepingRows).mockImplementation(async table => table === 'assistant_workspaces'
    ? [{ instance_id: randomUUID(), sandbox_name: `a-${randomUUID()}`, active_sandbox_name: name,
      lease_expires_at: new Date(Date.now()+300000).toISOString() }]
    : table === 'sandbox_billing_resources' ? [{ sandbox_name: name }] : []);
  jest.mocked(listHousekeepingSandboxes).mockResolvedValue([{ id: name, name, createdAt: Date.now()-3600000 }]);
  jest.mocked(Sandbox.get).mockResolvedValue({ name, status: 'running', currentSnapshotId: randomUUID() } as never);
  expect((await GET(request())).status).toBe(200);
  expect(stopSandboxQuiet).not.toHaveBeenCalled();
  expect(reconcileSandboxBilling).toHaveBeenCalled();
});

it('reconciles a queued instance deletion without treating the queue as an exclusive claim', async () => {
  const name = `a-${randomUUID()}`;
  jest.mocked(housekeepingRows).mockImplementation(async table => table === 'assistant_workspace_deletions'
    ? [{ sandbox_name: name }] : table === 'sandbox_billing_resources' ? [{ sandbox_name: name }] : []);
  jest.mocked(Sandbox.get).mockResolvedValue({ name, status: 'stopped', currentSnapshotId: randomUUID() } as never);
  const response = await GET(request());
  expect((await response.json()).results).toMatchObject({sandboxesBilled: 1, deferredDeletionIntents: 1});
  expect(reconcileSandboxBilling).toHaveBeenCalled();
  expect(deleteSandboxAndOrphans).not.toHaveBeenCalled();
  expect(retireSandboxBilling).not.toHaveBeenCalledWith(name, 'finish');
});
it('rejects missing cron secret rather than authorizing Bearer undefined',async()=>{
  delete process.env.CRON_SECRET;
  const response=await GET(new Request('https://api.example.test/cron',{headers:{authorization:'Bearer undefined'}}));
  expect(response.status).toBe(401);expect(Sandbox.get).not.toHaveBeenCalled();
});
const request=()=>new Request('https://api.example.test/cron',{headers:{authorization:`Bearer ${credentials.CRON_SECRET}`}});
it('uses automatic project OIDC in Vercel without passing stale explicit credentials',async()=>{
  process.env.VERCEL='1';delete process.env.VERCEL_TOKEN;delete process.env.VERCEL_PROJECT_ID;delete process.env.VERCEL_TEAM_ID;
  const name=`h-${randomUUID()}`;
  jest.mocked(housekeepingRows).mockImplementation(async table=>table==='sandbox_billing_resources'?[{sandbox_name:name}]:[]);
  jest.mocked(Sandbox.get).mockResolvedValue({name,status:'stopped',currentSnapshotId:'snapshot'} as never);
  expect((await GET(request())).status).toBe(200);
  expect(listHousekeepingSandboxes).toHaveBeenCalledWith({});
  expect(Sandbox.get).toHaveBeenCalledWith({name,resume:false});
});
it('keeps explicit non-Vercel credentials all-or-nothing',async()=>{
  delete process.env.VERCEL_TOKEN;
  expect((await GET(request())).status).toBe(500);
  expect(listHousekeepingSandboxes).not.toHaveBeenCalled();expect(Sandbox.get).not.toHaveBeenCalled();
});
it('aborts before provider inventory or cleanup when the status scan fails', async () => {
  jest.mocked(requirementStatusReferences).mockRejectedValueOnce(new Error('incomplete status scan'));
  expect((await GET(request())).status).toBe(500);
  expect(listHousekeepingSandboxes).not.toHaveBeenCalled();
  expect(Sandbox.get).not.toHaveBeenCalled();
  expect(deleteSnapshotQuiet).not.toHaveBeenCalled();
  expect(stopSandboxQuiet).not.toHaveBeenCalled();
});
it.each([403, 500])('fails closed on inventory HTTP %i without logging credentials', async status => {
  jest.mocked(listHousekeepingSandboxes).mockRejectedValueOnce({response: {status}, message: credentials.VERCEL_TOKEN});
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  expect((await GET(request())).status).toBe(500);
  expect(Sandbox.get).not.toHaveBeenCalled(); expect(stopSandboxQuiet).not.toHaveBeenCalled();
  expect(deleteSnapshotQuiet).not.toHaveBeenCalled(); expect(retireSandboxBilling).not.toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain(credentials.VERCEL_TOKEN);
  expect(log).toHaveBeenCalledWith(expect.any(String), {stage: 'sandbox_inventory', httpStatus: status});
});
it('ignores empty legacy snapshot rows rather than crashing the inventory',async()=>{
  jest.mocked(housekeepingRows).mockImplementation(async table=>table==='harness_sessions'?[{snapshot:null}]:[]);
  expect((await GET(request())).status).toBe(200);
  expect(stopSandboxQuiet).not.toHaveBeenCalled();
});
it('reports missing registered-resource billing as pending instead of forgiving unproven disappearance',async()=>{
  const name=`tracked-${randomUUID()}`;const notFound={response:{status:404}};
  jest.mocked(housekeepingRows).mockImplementation(async table=>table==='sandbox_billing_resources'?[{sandbox_name:name,deletion_requested_at:null}]:[]);
  jest.mocked(Sandbox.get).mockRejectedValue(notFound);jest.mocked(isSandboxNotFoundError).mockImplementation(error=>error===notFound);
  jest.mocked(retireSandboxBilling).mockRejectedValue(new Error('Unproven disappearance'));
  const response=await GET(request());
  expect(response.status).toBe(200);
  expect((await response.json()).results).toMatchObject({billingErrors:1,sandboxesBilled:0});
  expect(retireSandboxBilling).not.toHaveBeenCalled();
  expect(reconcileSandboxBilling).not.toHaveBeenCalled();expect(stopSandboxQuiet).not.toHaveBeenCalled();expect(deleteSnapshotQuiet).not.toHaveBeenCalled();
});

it.each(['completed','cancelled','failed'])('deletes canonical %s h-session only under trusted terminal/all-reference proof and final billing',async status=>{
  const id=randomUUID(),site=randomUUID(),req=randomUUID(),name=`h-${id}`;
  jest.mocked(housekeepingRows).mockImplementation(async table=>table==='harness_sessions'
    ?[{id,site_id:site,snapshot:{status,request:{requirementId:req},workspace:{id:name}}}]
    :table==='sandbox_billing_resources'?[{sandbox_name:name}]:[]);
  const sandbox={name,status:'running',delete:jest.fn().mockResolvedValue(undefined)};
  jest.mocked(Sandbox.get).mockResolvedValue(sandbox as never);jest.mocked(stopSandboxQuiet).mockResolvedValue(true);
  const fence={assert:jest.fn().mockResolvedValue(undefined),finish:jest.fn().mockResolvedValue(undefined)};
  jest.mocked(claimSandboxCleanup).mockResolvedValue(fence);
  const response=await GET(request());
  expect((await response.json()).results.terminalSandboxesDeleted).toBe(1);
  expect(claimSandboxCleanup).toHaveBeenCalledWith({sessionId:id,siteId:site,owner:null,resource:name});
  expect(sandbox.delete).toHaveBeenCalledWith({deleteOrphanSnapshots:true});
  expect(retireSandboxBilling).toHaveBeenCalledWith(name,'begin');expect(retireSandboxBilling).toHaveBeenCalledWith(name,'finish');
  const ordered = [
    jest.mocked(reconcileSandboxBilling).mock.invocationCallOrder[0],
    jest.mocked(claimSandboxCleanup).mock.invocationCallOrder[0], fence.assert.mock.invocationCallOrder[0],
    jest.mocked(stopSandboxQuiet).mock.invocationCallOrder[0], jest.mocked(reconcileSandboxBilling).mock.invocationCallOrder[1],
    jest.mocked(retireSandboxBilling).mock.invocationCallOrder[0], fence.assert.mock.invocationCallOrder[1],
    sandbox.delete.mock.invocationCallOrder[0], jest.mocked(retireSandboxBilling).mock.invocationCallOrder[1],
    fence.finish.mock.invocationCallOrder[0],
  ];
  expect(ordered.every((order, i) => Number.isInteger(order) && (i === 0 || order > ordered[i-1]))).toBe(true);
});
it('preserves a failed h-session when SQL ownership/reference proof refuses',async()=>{
  const id=randomUUID(),name=`h-${id}`;
  jest.mocked(housekeepingRows).mockImplementation(async table=>table==='harness_sessions'
    ?[{id,site_id:randomUUID(),snapshot:{status:'failed',request:{requirementId:randomUUID()}}}]
    :table==='sandbox_billing_resources'?[{sandbox_name:name}]:[]);
  const sandbox={name,status:'stopped',delete:jest.fn()};jest.mocked(Sandbox.get).mockResolvedValue(sandbox as never);
  expect((await GET(request())).status).toBe(200);
  expect(claimSandboxCleanup).toHaveBeenCalled();expect(sandbox.delete).not.toHaveBeenCalled();
});
it('four historical tracked 404s stay actionable pending, never false recovery',async()=>{
  const rows=Array.from({length:4},()=>({sandbox_name:`h-${randomUUID()}`,deletion_requested_at:null}));
  jest.mocked(housekeepingRows).mockImplementation(async table=>table==='sandbox_billing_resources'?rows:[]);
  const error={response:{status:404}};jest.mocked(Sandbox.get).mockRejectedValue(error);jest.mocked(isSandboxNotFoundError).mockReturnValue(true);
  const response=await GET(request());
  expect((await response.json()).results).toMatchObject({billingErrors:4,missingResources:4,fundingPending:0,sandboxesBilled:0});
  expect(retireSandboxBilling).not.toHaveBeenCalled();expect(claimSandboxCleanup).not.toHaveBeenCalled();
});

it.each(['insufficient_credits','reconciliation_pending'] as const)('reports %s without retiring or forgiving usage',async code=>{
  const name=`h-${randomUUID()}`;
  jest.mocked(housekeepingRows).mockImplementation(async table=>table==='sandbox_billing_resources'?[{sandbox_name:name}]:[]);
  jest.mocked(Sandbox.get).mockResolvedValue({name,status:'running'} as never);
  jest.mocked(reconcileSandboxBilling).mockRejectedValue(new SandboxBillingError(code));
  const response=await GET(request());
  expect((await response.json()).results).toMatchObject({billingErrors:1,missingResources:0,
    fundingPending:code==='insufficient_credits'?1:0,reconciliationPending:code==='reconciliation_pending'?1:0});
  expect(retireSandboxBilling).not.toHaveBeenCalled();
  expect(stopSandboxQuiet).not.toHaveBeenCalled();
});

it('finishes billing retirement only for a missing VM with recorded deletion intent', async () => {
  const name = `wf-${randomUUID()}`;
  jest.mocked(housekeepingRows).mockImplementation(async table => table === 'sandbox_billing_resources'
    ? [{sandbox_name: name, deletion_requested_at: new Date().toISOString()}] : []);
  const gone = {response: {status: 404}};
  jest.mocked(Sandbox.get).mockRejectedValue(gone);
  jest.mocked(isSandboxNotFoundError).mockImplementation(error => error === gone);
  expect((await GET(request())).status).toBe(200);
  expect(retireSandboxBilling).toHaveBeenCalledWith(name, 'finish');
  expect(stopSandboxQuiet).not.toHaveBeenCalled();
});

// Deterministic interleavings: do not mutate the sets already returned to the scan.
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

it.each([1, 3])('does not destroy a VM or snapshot adopted after reference discovery (SDK %i)', async major => {
  jest.mocked(sandboxSdkMajor).mockReturnValue(major);
  const name = `wf-${randomUUID()}`, snapshot = randomUUID();
  const snapshotList = (Sandbox as unknown as {listSnapshots: jest.Mock}).listSnapshots;
  snapshotList.mockResolvedValue({snapshots: [{id: snapshot, status: 'ready', createdAt: new Date(0).toISOString()}]});
  const references = { vms: new Set<string>(), snapshots: new Set<string>() };
  jest.mocked(requirementStatusReferences).mockImplementation(async () => ({
    activeSandboxIds: new Set(references.vms), activeSnapshotIds: new Set(references.snapshots),
  }));
  const entered = barrier(), resume = barrier();
  jest.mocked(listHousekeepingSandboxes).mockImplementationOnce(async () => {
    entered.release(); await resume.wait;
    return [{ id: name, createdAt: Date.now() - 3600000 }];
  });
  const vm = { name, status: 'running', delete: jest.fn() };
  jest.mocked(Sandbox.get).mockResolvedValue(vm as never);
  const sweep = GET(request());
  await entered.wait;
  references.vms.add(name); references.snapshots.add(snapshot);
  resume.release();
  const response = await sweep;
  expect((await response.json()).results).toMatchObject({ unfencedSandboxCandidates: 1,
    sandboxesStopped: 0, sandboxesAlreadyStopped: 0, snapshotsDeleted: 0 });
  expect(stopSandboxQuiet).not.toHaveBeenCalled(); expect(vm.delete).not.toHaveBeenCalled();
  expect(snapshotList).not.toHaveBeenCalled(); expect(deleteSnapshotQuiet).not.toHaveBeenCalled();
  expect(Sandbox.get).not.toHaveBeenCalled();
});

it.each(['refused', 'lost'] as const)('does not fall back to an unfenced stop after terminal claim is %s', async outcome => {
  const id = randomUUID(), name = `h-${id}`;
  const session = { id, site_id: randomUUID(), snapshot: { status: 'failed', request: { requirementId: randomUUID() } } };
  jest.mocked(housekeepingRows).mockImplementation(async table => table === 'harness_sessions'
    ? [structuredClone(session)] : table === 'sandbox_billing_resources' ? [{sandbox_name: name, deletion_requested_at: 'pending'}] : []);
  jest.mocked(listHousekeepingSandboxes).mockResolvedValue([{id: name, createdAt: 0}]);
  const vm = { name, status: 'running', delete: jest.fn() };
  jest.mocked(Sandbox.get).mockResolvedValue(vm as never);
  const entered = barrier(), resume = barrier();
  const fence = { assert: async () => { throw new Error('claim lost'); }, finish: jest.fn() };
  jest.mocked(claimSandboxCleanup).mockImplementation(async () => {
    entered.release(); await resume.wait;
    return session.snapshot.status === 'running' && outcome === 'refused' ? null : fence;
  });
  const sweep = GET(request());
  await entered.wait;
  session.snapshot.status = 'running';
  resume.release();
  const response = await sweep;
  expect((await response.json()).results).toMatchObject({terminalSandboxesDeleted: 0, unfencedSandboxCandidates: 1,
    billingErrors: outcome === 'lost' ? 1 : 0});
  expect(reconcileSandboxBilling).toHaveBeenCalledWith(vm);
  expect(stopSandboxQuiet).not.toHaveBeenCalled(); expect(vm.delete).not.toHaveBeenCalled();
  expect(deleteSandboxAndOrphans).not.toHaveBeenCalled(); expect(retireSandboxBilling).not.toHaveBeenCalled();
  expect(fence.finish).not.toHaveBeenCalled();
});
