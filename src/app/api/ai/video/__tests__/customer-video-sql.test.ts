import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { spawnSync } from 'node:child_process';

const vmModules = process.execArgv.includes('--experimental-vm-modules');
(vmModules ? it.skip : it)('executes isolated PostgreSQL WASM contracts in a VM-enabled Node process', () => {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js',
    '--config', 'jest.ai.config.js', '--runInBand', '--runTestsByPath', __filename],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 90000 });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  expect(child.stderr).toContain('9 passed');
}, 100000);

(vmModules ? describe : describe.skip)('durable video SQL', () => {

const site = '11111111-1111-4111-8111-111111111111';
const connection = '22222222-2222-4222-8222-222222222222';
const job = { id: '33333333-3333-4333-8333-333333333333', eventId: '44444444-4444-4444-8444-444444444444',
  siteId: site, routing: { payer: 'customer', siteId: site, connectionId: connection, policyVersion: 2, credentialVersion: 3 },
  request: { model: 'vendor/video', prompt: 'Garden', duration: 4, aspect_ratio: '16:9' },
  fingerprint: 'a'.repeat(64), operationKey: 'video:test-operation', status: 'pending', createdAt: '2026-11-12T00:00:00Z' };
let db: PGlite;
const save = (value: unknown) => db.query('select public.openrouter_customer_video_save($1::jsonb) as job', [JSON.stringify(value)]);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.sites(id uuid PRIMARY KEY);
    CREATE TABLE public.openrouter_customer_connections(id uuid PRIMARY KEY, site_id uuid NOT NULL);
    INSERT INTO public.sites VALUES ('${site}');
    INSERT INTO public.openrouter_customer_connections VALUES ('${connection}','${site}');`);
  await db.exec(readFileSync(resolve(process.cwd(), '../market-fit/supabase/migrations/20261112060000_openrouter_customer_video_jobs.sql'), 'utf8'));
}, 30000);
afterAll(async () => db?.close());
beforeEach(async () => { await db.exec('TRUNCATE public.openrouter_customer_video_jobs'); });

it('persists status and accepted upstream identity with original pin', async () => {
  await save(job);
  await save({ ...job, upstreamId: 'provider-1', status: 'in_progress' });
  const found = await db.query<{ job: any }>('select public.openrouter_customer_video_load($1,$2,null) as job', [site, job.id]);
  expect(found.rows[0].job).toMatchObject({ upstreamId: 'provider-1', routing: job.routing });
  const wrong = await db.query<{ job: any }>('select public.openrouter_customer_video_load($1,$2,null) as job', [connection, job.id]);
  expect(wrong.rows[0].job).toBeNull();
});
it('serializes competing operation inserts without granting a second job', async () => {
  const attempts = await Promise.allSettled([save(job), save({ ...job, id: job.eventId })]);
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect((await db.query('select * from public.openrouter_customer_video_jobs')).rows).toHaveLength(1);
});
it.each(['routing', 'request', 'eventId', 'fingerprint'])('rejects immutable %s rebinding', async field => {
  await save(job);
  const changed = field === 'routing' ? { ...job.routing, policyVersion: 4 }
    : field === 'request' ? { ...job.request, model: 'other/video' }
    : field === 'fingerprint' ? 'b'.repeat(64) : connection;
  await expect(save({ ...job, [field]: changed })).rejects.toThrow();
});
it('never overwrites accepted provider identity or terminal state', async () => {
  await save(job);
  await save({ ...job, upstreamId: 'provider-1' });
  await expect(save({ ...job, upstreamId: 'provider-2' })).rejects.toThrow();
  await save({ ...job, upstreamId: 'provider-1', status: 'completed', videos: [{ url: 'https://storage.example.test/v.mp4' }] });
  await expect(save({ ...job, upstreamId: 'provider-1' })).rejects.toThrow();
});
it('rejects credential material and unowned connections', async () => {
  await expect(save({ ...job, routing: { ...job.routing, apiKey: 'not-a-key' } })).rejects.toThrow();
  await expect(save({ ...job, routing: { ...job.routing, connectionId: job.id } })).rejects.toThrow();
});
it('denies client roles and grants service RPC only, not direct table mutation', async () => {
  await db.exec('SET ROLE authenticated');
  await expect(save(job)).rejects.toThrow();
  await db.exec('RESET ROLE; SET ROLE service_role');
  await save(job);
  await expect(db.query('select * from public.openrouter_customer_video_jobs')).rejects.toThrow();
  await db.exec('RESET ROLE');
});
});