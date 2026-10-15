import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Sandbox } from '@vercel/sandbox';
import { billableSession, reconcileSandboxBilling, registerSandboxBilling, SANDBOX_CREDITS_PER_HOUR } from '../sandbox-billing';

it('executes actual sandbox SQL offline in disposable PostgreSQL', () => {
  const output = execFileSync(process.execPath, [resolve(process.cwd(),'src/lib/services/billing/__tests__/sandbox-billing-sql-runner.mjs')],
    { encoding:'utf8', timeout:120000, env:{ PATH:process.env.PATH, NODE_ENV:'test' } });
  expect(output).toContain('Sandbox SQL: 11 checks passed');
});
it('uses actual session starts, terminal stop/abort/duration endpoints, never sandbox creation', () => {
  expect(SANDBOX_CREDITS_PER_HOUR).toBe(0.5);
  const start=Date.now()-10000,id=randomUUID();
  expect(billableSession({id,status:'pending'})).toBeNull();
  expect(billableSession({id,status:'failed'})).toBeNull();
  expect(billableSession({id,status:'stopped',startedAt:start,stoppedAt:start+1000})?.ended_at).toBe(new Date(start+1000).toISOString());
  expect(billableSession({id,status:'aborted',startedAt:start,abortedAt:start+2000,duration:99999})?.ended_at).toBe(new Date(start+2000).toISOString());
  expect(billableSession({id,status:'stopped',startedAt:start,duration:3000})?.ended_at).toBe(new Date(start+3000).toISOString());
  expect(() => billableSession({id,status:'stopped',startedAt:start})).toThrow('pending');
  expect(() => billableSession({id,status:'running'})).toThrow('pending');
  expect(() => billableSession({id,status:'stopped',startedAt:start,stoppedAt:start-1})).toThrow('pending');
});
it('paginates SDK v3 histories with one observation timestamp and never resumes/stops', async () => {
  const start=Date.now()-3600000;
  const listSessions=jest.fn().mockResolvedValueOnce({sessions:[{id:randomUUID(),status:'stopped',startedAt:start,stoppedAt:start+1000}],pagination:{next:'next'}})
    .mockResolvedValueOnce({sessions:[{id:randomUUID(),status:'running',startedAt:start+2000}],pagination:{next:null}});
  const db={rpc:jest.fn().mockResolvedValue({data:{success:true},error:null})};
  const sandbox={name:'synthetic',listSessions,resume:jest.fn(),stop:jest.fn()};
  await reconcileSandboxBilling(sandbox as unknown as Sandbox,db);
  expect(listSessions.mock.calls[1][0].cursor).toBe('next');
  expect(db.rpc.mock.calls[0][1].p_observed_at).toBe(db.rpc.mock.calls[1][1].p_observed_at);
  expect(sandbox.resume).not.toHaveBeenCalled(); expect(sandbox.stop).not.toHaveBeenCalled();
});
it('registration uses host owner and opaque failure, without surfacing credential-bearing errors', async () => {
  const db={rpc:jest.fn().mockResolvedValue({data:{success:true},error:null})};
  const owner={kind:'requirement' as const,id:randomUUID(),siteId:randomUUID()};
  await registerSandboxBilling('synthetic',owner,db);
  expect(db.rpc).toHaveBeenCalledWith('register_sandbox_billing',{p_sandbox_name:'synthetic',p_owner_kind:owner.kind,p_owner_id:owner.id,p_site_id:owner.siteId});
  const token=randomBytes(24).toString('hex'),username=randomBytes(12).toString('hex'),password=randomBytes(24).toString('hex');
  const url=new URL('https://provider.example.test/session');url.username=username;url.password=password;url.searchParams.set('token',token);
  db.rpc.mockResolvedValue({data:null,error:{message:url.href}});
  const error=await registerSandboxBilling('synthetic',owner,db).catch(e=>e);
  expect(String(error)).toContain('reconciled');
  for (const secret of [token,username,password]) expect(String(error)).not.toContain(secret);
});
it('never records full-history completion on later page failure or cursor repetition',async()=>{
  const start=Date.now()-10000;
  const listSessions=jest.fn().mockResolvedValueOnce({sessions:[{id:randomUUID(),status:'running',startedAt:start}],pagination:{next:'next'}})
    .mockRejectedValueOnce(new Error('synthetic transport outage'));
  const db={rpc:jest.fn().mockResolvedValue({data:{success:true},error:null})};
  await expect(reconcileSandboxBilling({name:'synthetic',listSessions} as unknown as Sandbox,db)).rejects.toThrow('pending');
  expect(db.rpc).not.toHaveBeenCalledWith('complete_sandbox_billing_observation',expect.anything());
});