import { randomBytes, randomUUID } from 'node:crypto';
import { GET } from '@/app/api/cron/maintenance/sandbox-housekeeping/route';
import { Sandbox } from '@vercel/sandbox';
import { housekeepingRows } from '../sandbox-housekeeping-db';
import { listHousekeepingSandboxes } from '../sandbox-housekeeping-list';
import { reconcileSandboxBilling } from '../sandbox-billing';
import { stopSandboxQuiet } from '@/lib/services/sandbox-stop';
import { deleteSnapshotQuiet } from '@/lib/services/sandbox-persisted-snapshot';
jest.mock('@vercel/sandbox',()=>({Sandbox:{get:jest.fn()}}));
jest.mock('../sandbox-housekeeping-db',()=>({housekeepingRows:jest.fn()}));
jest.mock('../sandbox-housekeeping-list',()=>({listHousekeepingSandboxes:jest.fn()}));
jest.mock('../sandbox-billing',()=>({reconcileSandboxBilling:jest.fn(),retireSandboxBilling:jest.fn()}));
jest.mock('@/lib/services/sandbox-stop',()=>({stopSandboxQuiet:jest.fn()}));
jest.mock('@/lib/services/sandbox-persisted-snapshot',()=>({deleteSnapshotQuiet:jest.fn()}));
jest.mock('@/lib/services/sandbox-sdk',()=>({sandboxSdkMajor:()=>3}));
jest.mock('@/lib/services/sandbox-lifecycle',()=>({deleteSandboxAndOrphans:jest.fn()}));
jest.mock('@/lib/services/sandbox-missing-snapshot',()=>({isSandboxNotFoundError:()=>false}));
const credentials={CRON_SECRET:randomBytes(24).toString('hex'),VERCEL_TOKEN:randomBytes(24).toString('hex'),VERCEL_TEAM_ID:'synthetic-team',VERCEL_PROJECT_ID:'synthetic-project'};
let saved:Record<string,string|undefined>;
beforeEach(()=>{jest.resetAllMocks();saved=Object.fromEntries(Object.keys(credentials).map(key=>[key,process.env[key]]));Object.assign(process.env,credentials);});
afterEach(()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
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
it('rejects missing cron secret rather than authorizing Bearer undefined',async()=>{
  delete process.env.CRON_SECRET;
  const response=await GET(new Request('https://api.example.test/cron',{headers:{authorization:'Bearer undefined'}}));
  expect(response.status).toBe(401);expect(Sandbox.get).not.toHaveBeenCalled();
});