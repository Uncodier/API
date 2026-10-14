import { randomBytes, randomUUID } from 'node:crypto';
import { createMemorySessionStore } from '../memory-store';
import { createSessionStore, sanitizeControlMessage, type SessionStoreClient } from '../store';
import type { HarnessSession } from '../types';

const scope = { siteId: randomUUID(), userId: randomUUID() };
function session(): HarnessSession {
  return { id: randomUUID(), version: 0, status: 'queued', request: {
    objective: 'Implement a portable task', repository: { url: 'https://example.test/repository' },
    limits: { maxTurns: 10, maxOutputTokens: 1024, maxTotalTokens: 100000, maxActiveMs: 30000 },
  }, messages: [], turns: 0, allocatedTokens: 0, activeMs: 0, uncertainOperations: [],
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
}

describe('portable in-memory session store', () => {
  it('isolates scopes and idempotent inserts without replacing progress', async () => {
    const store = createMemorySessionStore(); const initial = session();
    await store.create(initial, scope);
    const owned = await store.claim(initial.id, scope.siteId, 'worker-1', 180);
    await store.create(initial, scope);
    expect(await store.load(initial.id, scope.siteId)).toEqual(owned);
    expect(await store.load(initial.id, randomUUID())).toBeNull();
    await expect(store.create(initial, { ...scope, userId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.create({ ...initial, request: { ...initial.request, objective: 'Other' } }, scope)).rejects.toMatchObject({ code: 'conflict' });
    owned!.messages.push({ role: 'user', content: 'Not persisted' });
    expect((await store.load(initial.id, scope.siteId))!.messages).toEqual([]);
  });

  it('has one lease; CAS, expired renewal, old owner, and tenant mismatch all fail closed', async () => {
    let now = 1000; const store = createMemorySessionStore({ now: () => now }); const initial = session();
    await store.create(initial, scope);
    const claims = await Promise.all(['a', 'b', 'c'].map(owner => store.claim(initial.id, scope.siteId, owner, 1)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owned = claims[0]!;
    expect(owned.version).toBe(1);
    await expect(store.save(owned, randomUUID(), 'a')).rejects.toMatchObject({ code: 'conflict' });
    const saved = await store.save({ ...owned, turns: 1 }, scope.siteId, 'a');
    expect(saved.version).toBe(2);
    await expect(store.save(owned, scope.siteId, 'a')).rejects.toMatchObject({ code: 'conflict' });
    now = 2000;
    await expect(store.assertOwner(initial.id, scope.siteId, 'a', 180)).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.save(saved, scope.siteId, 'a')).rejects.toMatchObject({ code: 'conflict' });
    const reclaimed = await store.claim(initial.id, scope.siteId, 'b', 180);
    await store.release(initial.id, scope.siteId, 'a');
    await store.assertOwner(initial.id, scope.siteId, 'b', 180);
    await expect(store.save({ ...reclaimed!, version: saved.version }, scope.siteId, 'a')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('pause/cancel fence the writer; resume retains budgets and pending ambiguity', async () => {
    const store = createMemorySessionStore(); const initial = session(); await store.create(initial, scope);
    const owned = (await store.claim(initial.id, scope.siteId, 'a', 180))!;
    const checkpoint = await store.save({ ...owned, turns: 2, allocatedTokens: 5000, activeMs: 50,
      pending: { call: { id: 'op1', name: 'publish', arguments: '{}' }, effect: 'write', fingerprint: 'fingerprint1' },
      uncertainOperations: ['fingerprint1'] }, scope.siteId, 'a');
    const paused = await store.control(initial.id, scope.siteId, 'pause');
    expect(paused!.version).toBe(checkpoint.version + 1);
    await expect(store.save(checkpoint, scope.siteId, 'a')).rejects.toMatchObject({ code: 'conflict' });
    const resumed = (await store.control(initial.id, scope.siteId, 'resume', 'Continue carefully'))!;
    expect(resumed).toMatchObject({ status: 'queued', turns: 2, allocatedTokens: 5000, activeMs: 50,
      pending: checkpoint.pending, uncertainOperations: checkpoint.uncertainOperations });
    expect(resumed.messages.at(-1)).toEqual({ role: 'user', content: 'Continue carefully' });
    const again = (await store.claim(initial.id, scope.siteId, 'b', 180))!;
    await store.control(initial.id, scope.siteId, 'cancel');
    await expect(store.save(again, scope.siteId, 'b')).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.control(initial.id, scope.siteId, 'resume')).toBeNull();
    expect(await store.claim(initial.id, scope.siteId, 'c', 180)).toBeNull();
  });

  it('protects immutable request/workspace and monotonic accounting; releases terminals unchanged', async () => {
    const store = createMemorySessionStore(); const initial = session(); await store.create(initial, scope);
    const owned = (await store.claim(initial.id, scope.siteId, 'a', 180))!;
    const checkpoint = await store.save({ ...owned, workspace: { provider: 'vercel', id: 'sandbox-a', root: '/workspace' }, turns: 1 }, scope.siteId, 'a');
    await expect(store.save({ ...checkpoint, request: { ...checkpoint.request, objective: 'Replacement' } }, scope.siteId, 'a')).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.save({ ...checkpoint, workspace: undefined }, scope.siteId, 'a')).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.save({ ...checkpoint, turns: 0 }, scope.siteId, 'a')).rejects.toMatchObject({ code: 'invalid' });
    const done = await store.save({ ...checkpoint, status: 'completed' }, scope.siteId, 'a');
    await store.release(initial.id, scope.siteId, 'a');
    expect(await store.load(initial.id, scope.siteId)).toEqual(done);
    expect(await store.control(initial.id, scope.siteId, 'resume')).toBeNull();
    await expect(store.assertOwner(initial.id, scope.siteId, 'a', 180)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('resumes queued dispatch failures and expired running sessions, never a live worker', async () => {
    let now = 1000; const store = createMemorySessionStore({ now: () => now }); const initial = session();
    await store.create(initial, scope);
    expect((await store.control(initial.id, scope.siteId, 'resume'))!.status).toBe('queued');
    const owned = (await store.claim(initial.id, scope.siteId, 'a', 1))!;
    const pending = { call: { id: 'effect', name: 'publish', arguments: '{}' }, effect: 'write' as const, fingerprint: 'effect' };
    await store.save({ ...owned, pending }, scope.siteId, 'a');
    expect(await store.control(initial.id, scope.siteId, 'resume')).toBeNull();
    now = 2000;
    const resumed = await store.control(initial.id, scope.siteId, 'resume');
    expect(resumed).toMatchObject({ status: 'queued', pending });
    await expect(store.save(owned, scope.siteId, 'a')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('waits for terminal worker cleanup/release before resuming waiting or failed', async () => {
    for (const status of ['waiting', 'failed'] as const) {
      const store = createMemorySessionStore(); const initial = session(); await store.create(initial, scope);
      const owned = (await store.claim(initial.id, scope.siteId, 'a', 180))!;
      await store.save({ ...owned, status }, scope.siteId, 'a');
      expect(await store.control(initial.id, scope.siteId, 'resume')).toBeNull();
      await store.release(initial.id, scope.siteId, 'a');
      expect((await store.control(initial.id, scope.siteId, 'resume'))!.status).toBe('queued');
    }
  });

  it('bounds TTL, storage limits and resume messages and redacts synthetic credentials', async () => {
    const store = createMemorySessionStore(); const initial = session(); await store.create(initial, scope);
    for (const ttl of [0, -1, 301, 1.5, NaN, Infinity]) await expect(store.claim(initial.id, scope.siteId, 'a', ttl)).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.claim(initial.id, scope.siteId, '', 10)).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.control(initial.id, scope.siteId, 'resume', 'x'.repeat(20001))).rejects.toMatchObject({ code: 'invalid' });
    const invalid = session(); invalid.request.limits.maxTurns = 1001;
    await expect(store.create(invalid, scope)).rejects.toMatchObject({ code: 'invalid' });
    const secrets = Array.from({ length: 5 }, () => randomBytes(24).toString('hex'));
    const url = new URL('https://example.test/repo'); url.username = secrets[0]; url.password = secrets[1]; url.searchParams.set('token', secrets[2]);
    const raw = `${url} Bearer ${secrets[3]}\n{"password":"${secrets[4]}"}`;
    await store.control(initial.id, scope.siteId, 'pause');
    const resumed = await store.control(initial.id, scope.siteId, 'resume', raw);
    for (const sensitive of secrets) expect(JSON.stringify(resumed)).not.toContain(sensitive);
    expect(sanitizeControlMessage('Continue with tests')).toBe('Continue with tests');
  });
});

describe('Supabase session adapter', () => {
  it('uses canonical RPC output, scoped arguments, redacted control, and safe errors', async () => {
    const canonical = { ...session(), version: 4, status: 'running' as const };
    const rpc = jest.fn().mockResolvedValue({ data: canonical, error: null });
    const client = { rpc, from: jest.fn() } as SessionStoreClient;
    const store = createSessionStore(client);
    expect(await store.save({ ...canonical, version: 3 }, scope.siteId, 'owner')).toEqual(canonical);
    expect(rpc).toHaveBeenCalledWith('save_harness_session', expect.objectContaining({ p_site_id: scope.siteId, p_owner: 'owner', p_snapshot: expect.objectContaining({ version: 3 }) }));
    const secret = randomBytes(24).toString('hex');
    await store.control(canonical.id, scope.siteId, 'resume', `password=${secret}`);
    expect(JSON.stringify(rpc.mock.calls.at(-1))).not.toContain(secret);
    rpc.mockResolvedValueOnce({ data: null, error: { message: `unsafe ${secret}` } });
    await expect(store.save(canonical, scope.siteId, 'owner')).rejects.toThrow('Harness session storage');
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(store.save(canonical, scope.siteId, 'owner')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('uses INSERT rather than upsert and verifies scope/request on a duplicate', async () => {
    const initial = session(); const eq = jest.fn().mockReturnThis();
    const query = { eq, maybeSingle: jest.fn().mockResolvedValue({ data: { snapshot: initial }, error: null }) };
    const insert = jest.fn().mockResolvedValue({ error: { code: '23505' } });
    const select = jest.fn().mockReturnValue(query);
    const store = createSessionStore({ from: jest.fn().mockReturnValue({ insert, select }), rpc: jest.fn() });
    await store.create(initial, scope);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ id: initial.id, site_id: scope.siteId, user_id: scope.userId }));
    expect(eq.mock.calls).toEqual([['id', initial.id], ['site_id', scope.siteId], ['user_id', scope.userId]]);
    query.maybeSingle.mockResolvedValueOnce({ data: null, error: null } as never);
    await expect(store.create(initial, scope)).rejects.toMatchObject({ code: 'conflict' });
    eq.mockClear();
    expect(await store.load(initial.id, scope.siteId)).toEqual(initial);
    expect(eq.mock.calls).toEqual([['id', initial.id], ['site_id', scope.siteId]]);
  });
});