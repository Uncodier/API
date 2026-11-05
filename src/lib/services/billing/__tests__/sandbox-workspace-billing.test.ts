import { createHash, randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { openWorkspace, WorkspaceError } from '@/lib/harness/workspace';
import { WORKSPACE_ISOLATION_VERSION } from '@/lib/harness/workspace-process-guard';
import { registerSandboxBilling, reconcileSandboxBilling, reconcileSandboxBillingQuiet, SandboxBillingError } from '../sandbox-billing';
jest.mock('@vercel/sandbox', () => ({ Sandbox:{get:jest.fn(),create:jest.fn()} }));
jest.mock('../sandbox-billing', () => ({ ...jest.requireActual('../sandbox-billing'), registerSandboxBilling:jest.fn(), reconcileSandboxBilling:jest.fn(), reconcileSandboxBillingQuiet:jest.fn() }));

const sessionId=randomUUID(),siteId=randomUUID(),name=`h-${sessionId}`;
const repository={url:'https://repository.example.test/team/repo.git'};
const input={sessionId,siteId,repository,assertActive:jest.fn(async()=>{})};
const fixture=()=>({name,persistent:true,status:'stopped',currentSnapshotId:randomUUID(),tags:{harnessIsolation:WORKSPACE_ISOLATION_VERSION,
  harnessSession:sessionId,harnessReady:'true',harnessRepository:createHash('sha256').update(JSON.stringify([repository.url,null])).digest('hex')},
  update:jest.fn(async()=>{}),stop:jest.fn(async()=>{}),runCommand:jest.fn()});
beforeEach(()=>jest.resetAllMocks());
it('registers trusted site before any provider access and bills stopped history before public resume',async()=>{
  const sandbox=fixture(); jest.mocked(Sandbox.get).mockResolvedValue(sandbox as never);
  await openWorkspace(input);
  expect(registerSandboxBilling).toHaveBeenCalledWith(name,{kind:'harness',id:sessionId,siteId});
  expect(jest.mocked(registerSandboxBilling).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(Sandbox.get).mock.invocationCallOrder[0]);
  expect(jest.mocked(reconcileSandboxBilling).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(Sandbox.get).mock.invocationCallOrder[1]);
  expect(Sandbox.get).toHaveBeenLastCalledWith(expect.objectContaining({name,resume:true,onResume:expect.any(Function)}));
  expect(sandbox.runCommand).not.toHaveBeenCalled(); // Ready work is never cloned/reset.
});
it('never creates or resumes on failed billing admission',async()=>{
  jest.mocked(registerSandboxBilling).mockRejectedValue(new SandboxBillingError());
  await expect(openWorkspace(input)).rejects.toThrow();
  expect(Sandbox.get).not.toHaveBeenCalled(); expect(Sandbox.create).not.toHaveBeenCalled();
});
it('does not stop an unfenced reused VM on billing failure; captures the owned handle for runtime cleanup',async()=>{
  const sandbox=fixture(); jest.mocked(Sandbox.get).mockResolvedValue(sandbox as never);
  jest.mocked(reconcileSandboxBilling).mockRejectedValue(new SandboxBillingError());
  const onOwnedHandle=jest.fn();
  await expect(openWorkspace({...input,onOwnedHandle})).rejects.toMatchObject({code:'WORKSPACE_BILLING_UNAVAILABLE'});
  expect(Sandbox.get).toHaveBeenCalledTimes(1); expect(Sandbox.create).not.toHaveBeenCalled();
  expect(sandbox.stop).not.toHaveBeenCalled(); expect(onOwnedHandle).toHaveBeenCalledWith(sandbox);
});
it('suspend stops then reconciles final provider timestamps',async()=>{
  const sandbox=fixture();sandbox.status='running';jest.mocked(Sandbox.get).mockResolvedValue(sandbox as never);
  const workspace=await openWorkspace(input);await workspace.suspend();
  expect(jest.mocked(reconcileSandboxBillingQuiet).mock.invocationCallOrder[0]).toBeGreaterThan(sandbox.stop.mock.invocationCallOrder[0]);
});

it('preserves insufficient credits through workspace opening and never resumes',async()=>{
  const sandbox=fixture();jest.mocked(Sandbox.get).mockResolvedValue(sandbox as never);
  jest.mocked(reconcileSandboxBilling).mockRejectedValue(new SandboxBillingError('insufficient_credits'));
  await expect(openWorkspace(input)).rejects.toMatchObject({code:'WORKSPACE_CREDITS_REQUIRED'});
  expect(Sandbox.get).toHaveBeenCalledTimes(1);
  expect(Sandbox.create).not.toHaveBeenCalled();expect(sandbox.runCommand).not.toHaveBeenCalled();
});

it.each([
  [401,'WORKSPACE_AUTHORIZATION_REQUIRED'],
  [403,'WORKSPACE_AUTHORIZATION_REQUIRED'],
  [402,'WORKSPACE_PROVIDER_BILLING_REQUIRED'],
  [429,'WORKSPACE_OPEN_FAILED'],
  [503,'WORKSPACE_OPEN_FAILED'],
])('does not misclassify resume HTTP %s as site accounting',async(status,code)=>{
  const sandbox=fixture();
  jest.mocked(Sandbox.get).mockResolvedValueOnce(sandbox as never).mockRejectedValueOnce({response:{status}});
  await expect(openWorkspace(input)).rejects.toMatchObject({code});
  expect(Sandbox.get).toHaveBeenCalledTimes(2);
  expect(Sandbox.create).not.toHaveBeenCalled();expect(sandbox.stop).not.toHaveBeenCalled();
  expect(sandbox.runCommand).not.toHaveBeenCalled();
});

it('preserves cancellation during resume instead of pausing accounting',async()=>{
  const sandbox=fixture(),controller=new AbortController();
  jest.mocked(Sandbox.get).mockResolvedValueOnce(sandbox as never).mockImplementationOnce(async()=>{
    controller.abort();throw controller.signal.reason;
  });
  await expect(openWorkspace({...input,signal:controller.signal})).rejects.toMatchObject({code:'ABORTED'});
  expect(Sandbox.create).not.toHaveBeenCalled();expect(sandbox.stop).not.toHaveBeenCalled();
});

it('preserves ownership errors detected after billing and before resume',async()=>{
  const sandbox=fixture(),ownership=new WorkspaceError('OWNERSHIP_LOST','Synthetic ownership changed');
  jest.mocked(Sandbox.get).mockResolvedValue(sandbox as never);
  jest.mocked(reconcileSandboxBilling).mockImplementation(async()=>{
    input.assertActive.mockRejectedValue(ownership);
  });
  await expect(openWorkspace(input)).rejects.toMatchObject({code:'ABORTED',effectStarted:false});
  expect(Sandbox.get).toHaveBeenCalledTimes(1);
  expect(sandbox.stop).not.toHaveBeenCalled();expect(sandbox.runCommand).not.toHaveBeenCalled();
});