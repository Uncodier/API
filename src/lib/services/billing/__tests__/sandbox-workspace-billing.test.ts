import { createHash, randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { openWorkspace } from '@/lib/harness/workspace';
import { WORKSPACE_ISOLATION_VERSION } from '@/lib/harness/workspace-process-guard';
import { registerSandboxBilling, reconcileSandboxBilling, reconcileSandboxBillingQuiet, SandboxBillingError } from '../sandbox-billing';
jest.mock('@vercel/sandbox', () => ({ Sandbox:{get:jest.fn(),create:jest.fn()} }));
jest.mock('../sandbox-billing', () => ({ registerSandboxBilling:jest.fn(), reconcileSandboxBilling:jest.fn(), reconcileSandboxBillingQuiet:jest.fn(),
  SandboxBillingError:class extends Error {} }));

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
it('stops existing VM and preserves pending history when reconciliation fails before resume',async()=>{
  const sandbox=fixture(); jest.mocked(Sandbox.get).mockResolvedValue(sandbox as never);
  jest.mocked(reconcileSandboxBilling).mockRejectedValue(new SandboxBillingError());
  await expect(openWorkspace(input)).rejects.toMatchObject({code:'WORKSPACE_BILLING_UNAVAILABLE'});
  expect(Sandbox.get).toHaveBeenCalledTimes(1); expect(Sandbox.create).not.toHaveBeenCalled();
  expect(sandbox.stop).toHaveBeenCalled(); expect(reconcileSandboxBillingQuiet).toHaveBeenCalledWith(sandbox);
});
it('suspend stops then reconciles final provider timestamps',async()=>{
  const sandbox=fixture();sandbox.status='running';jest.mocked(Sandbox.get).mockResolvedValue(sandbox as never);
  const workspace=await openWorkspace(input);await workspace.suspend();
  expect(jest.mocked(reconcileSandboxBillingQuiet).mock.invocationCallOrder[0]).toBeGreaterThan(sandbox.stop.mock.invocationCallOrder[0]);
});