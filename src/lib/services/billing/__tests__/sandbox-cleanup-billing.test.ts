import type { Sandbox } from '@vercel/sandbox';
import { stopSandboxQuiet } from '@/lib/services/sandbox-stop';
import { deleteSandboxAndOrphans } from '@/lib/services/sandbox-lifecycle';
import { getSandboxHandle } from '@/lib/services/sandbox-sdk';
import { reconcileSandboxBillingQuiet } from '../sandbox-billing';
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{}}));
jest.mock('@/lib/services/sandbox-sdk',()=>({getSandboxHandle:jest.fn(),sandboxSdkMajor:()=>3}));
jest.mock('../sandbox-billing',()=>({reconcileSandboxBillingQuiet:jest.fn(),retireSandboxBilling:jest.fn()}));
jest.mock('@/lib/services/sandbox-missing-snapshot',()=>({isSandboxNotFoundError:()=>false}));
beforeEach(()=>{jest.resetAllMocks();jest.mocked(reconcileSandboxBillingQuiet).mockResolvedValue(true);});
it('reconciles stop response but never silently drops unpaid history by deleting it',async()=>{
  const sandbox={name:'synthetic',status:'running',stop:jest.fn(async()=>{}),delete:jest.fn(async()=>{})};
  jest.mocked(getSandboxHandle).mockResolvedValue(sandbox as unknown as Sandbox);
  jest.mocked(reconcileSandboxBillingQuiet).mockResolvedValue(false);
  await deleteSandboxAndOrphans(sandbox.name);
  expect(sandbox.stop).toHaveBeenCalledTimes(1);expect(sandbox.delete).not.toHaveBeenCalled();
});
it('deletes only after a confirmed stop and final successful reconciliation',async()=>{
  const sandbox={name:'synthetic',status:'running',stop:jest.fn(async()=>{}),delete:jest.fn(async()=>{})};
  jest.mocked(getSandboxHandle).mockResolvedValue(sandbox as unknown as Sandbox);
  await deleteSandboxAndOrphans(sandbox.name);
  expect(sandbox.delete).toHaveBeenCalledWith({deleteOrphanSnapshots:true});
  expect(sandbox.delete.mock.invocationCallOrder[0]).toBeGreaterThan(jest.mocked(reconcileSandboxBillingQuiet).mock.invocationCallOrder.at(-1)!);
});
it('already stopped shell reconciles without implicit provider resume or unnecessary stop',async()=>{
  const sandbox={name:'synthetic',status:'stopped',stop:jest.fn(async()=>{})};
  expect(await stopSandboxQuiet(sandbox as unknown as Sandbox)).toBe(true);
  expect(sandbox.stop).not.toHaveBeenCalled();expect(reconcileSandboxBillingQuiet).toHaveBeenCalled();
});