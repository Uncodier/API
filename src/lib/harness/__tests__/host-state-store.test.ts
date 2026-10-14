import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createHostStateStore, createMemoryHostStateStore, HOST_STATE_MAX_BYTES } from '../host-state-store';
import { createMemorySessionStore } from '../memory-store';
import { createSession, sessionRequestSchema } from '../session';
import type { HostConfiguration } from '../types';

function configuration(): HostConfiguration {
  const oldValue = randomBytes(32).toString('hex');
  const password = randomBytes(32).toString('hex');
  const username = randomBytes(16).toString('hex');
  const url = new URL('https://database.example.invalid/path');
  url.username = username; url.password = password;
  return { layers: { tenant: { values: { ACCESS_TOKEN: oldValue, DATABASE_URL: url.toString() },
    expiresAt: '2099-01-01T00:00:00Z', refresh: { kind: 'tenant', requirementId: randomUUID() } } },
  redactionValues: [oldValue, password, username, url.toString()] };
}

async function fixture() {
  let now = 1000;
  const sessions = createMemorySessionStore({ now: () => now });
  const session = createSession(sessionRequestSchema.parse({ objective: 'Offline storage test', repository: { url: 'https://repo.example.invalid/repository' } }));
  const scope = { siteId: randomUUID(), userId: randomUUID() };
  await sessions.create(session, scope);
  await sessions.claim(session.id, scope.siteId, 'worker', 180);
  const key = randomBytes(32).toString('base64');
  return { sessions, session, scope, key, store: createMemoryHostStateStore(sessions, key), expire: () => { now += 181_000; } };
}

describe('private encrypted host state', () => {
  it('returns empty owned state without a row and preserves rotations across releases and adapter reconstruction', async () => {
    const f = await fixture();
    expect(await f.store.load(f.session.id, f.scope.siteId, 'worker')).toEqual({ version: 0, configuration: { layers: {}, redactionValues: [] } });
    const first = configuration();
    expect(await f.store.save(f.session.id, f.scope.siteId, 'worker', 0, first)).toBe(1);
    const rotated = configuration(); rotated.redactionValues.push(...first.redactionValues);
    expect(await f.store.save(f.session.id, f.scope.siteId, 'worker', 1, rotated)).toBe(2);
    await f.sessions.release(f.session.id, f.scope.siteId, 'worker');
    await f.sessions.claim(f.session.id, f.scope.siteId, 'next', 180);
    const next = createMemoryHostStateStore(f.sessions, f.key);
    const recovered = await next.load(f.session.id, f.scope.siteId, 'next');
    expect(recovered).toEqual({ version: 2, configuration: rotated });
    recovered.configuration.redactionValues.length = 0;
    expect((await next.load(f.session.id, f.scope.siteId, 'next')).configuration.redactionValues).toEqual(rotated.redactionValues);
    const transcript = JSON.stringify(await f.sessions.load(f.session.id, f.scope.siteId));
    for (const value of [...first.redactionValues, ...rotated.redactionValues]) expect(transcript.includes(value)).toBe(false);
  });

  it('fences stale owner, tenant, missing session, expired leases and non-running sessions on reads AND writes', async () => {
    const f = await fixture(); const config = configuration();
    for (const [id, site, owner] of [[randomUUID(), f.scope.siteId, 'worker'], [f.session.id, randomUUID(), 'worker'], [f.session.id, f.scope.siteId, 'old']]) {
      await expect(f.store.load(id, site, owner)).rejects.toMatchObject({ code: 'conflict' });
      await expect(f.store.save(id, site, owner, 0, config)).rejects.toMatchObject({ code: 'conflict' });
    }
    f.expire();
    await expect(f.store.load(f.session.id, f.scope.siteId, 'worker')).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.store.save(f.session.id, f.scope.siteId, 'worker', 0, config)).rejects.toMatchObject({ code: 'conflict' });
    await f.sessions.claim(f.session.id, f.scope.siteId, 'next', 180);
    await f.sessions.control(f.session.id, f.scope.siteId, 'pause');
    await expect(f.store.load(f.session.id, f.scope.siteId, 'next')).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.store.save(f.session.id, f.scope.siteId, 'next', 0, config)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('uses CAS and never silently prunes historical redaction values or oversized configuration', async () => {
    const f = await fixture(); const config = configuration();
    const results = await Promise.allSettled([f.store.save(f.session.id, f.scope.siteId, 'worker', 0, config), f.store.save(f.session.id, f.scope.siteId, 'worker', 0, config)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const tooMany = { layers: {}, redactionValues: Array.from({ length: 1001 }, () => randomBytes(8).toString('hex')) };
    await expect(f.store.save(f.session.id, f.scope.siteId, 'worker', 1, tooMany)).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.store.save(f.session.id, f.scope.siteId, 'worker', 1, { layers: { test: { values: { OUTPUT: 'x'.repeat(HOST_STATE_MAX_BYTES) } } }, redactionValues: [] })).rejects.toMatchObject({ code: 'invalid' });
    expect(await f.store.load(f.session.id, f.scope.siteId, 'worker')).toEqual({ version: 1, configuration: config });
    const maxValues = { layers: {}, redactionValues: tooMany.redactionValues.slice(0, 1000) };
    await f.store.save(f.session.id, f.scope.siteId, 'worker', 1, maxValues);
    expect((await f.store.load(f.session.id, f.scope.siteId, 'worker')).configuration.redactionValues).toHaveLength(1000);
  });

  it('sends only ciphertext, uses random IVs and authenticates key, session, site, version and ciphertext', async () => {
    const key = randomBytes(32).toString('hex'), id = randomUUID(), site = randomUUID();
    let row: { version: number; ciphertext: string } | null = null;
    const rpc = jest.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'save_harness_host_state') {
        row = { version: Number(args.p_expected_version) + 1, ciphertext: args.p_ciphertext as string };
        return { data: row.version, error: null };
      }
      return { data: row, error: null };
    });
    const store = createHostStateStore({ rpc }, key); const config = configuration();
    await store.save(id, site, 'worker', 0, config);
    const original = { ...row! };
    const representation = JSON.stringify(rpc.mock.calls);
    for (const value of config.redactionValues) expect(representation.includes(value)).toBe(false);
    expect(representation.includes(key)).toBe(false);
    expect(Buffer.byteLength(original.ciphertext)).toBeLessThanOrEqual(HOST_STATE_MAX_BYTES);
    expect(await store.load(id, site, 'worker')).toEqual({ version: 1, configuration: config });
    await store.save(id, site, 'worker', 0, config);
    expect(row!.ciphertext).not.toBe(original.ciphertext);
    row = original;
    await expect(store.load(randomUUID(), site, 'worker')).rejects.toMatchObject({ code: 'encryption' });
    await expect(store.load(id, randomUUID(), 'worker')).rejects.toMatchObject({ code: 'encryption' });
    await expect(createHostStateStore({ rpc }, randomBytes(32).toString('hex')).load(id, site, 'worker')).rejects.toMatchObject({ code: 'encryption' });
    row = { ...original, version: 2 };
    await expect(store.load(id, site, 'worker')).rejects.toMatchObject({ code: 'encryption' });
    const parts = original.ciphertext.split('.'); const body = Buffer.from(parts[3], 'base64'); body[0] ^= 1; parts[3] = body.toString('base64');
    row = { ...original, ciphertext: parts.join('.') };
    await expect(store.load(id, site, 'worker')).rejects.toMatchObject({ code: 'encryption' });
  });

  it('uses SHA256 domain-separated key derivation and fails closed when encryption is unavailable', async () => {
    const key = randomBytes(32).toString('hex'), id = randomUUID(), site = randomUUID();
    const domain = 'portable-harness/host-state/aes-256-gcm/v1';
    const iv = randomBytes(12); const config = configuration();
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(domain).update('\0key\0').update(key).digest(), iv);
    cipher.setAAD(Buffer.from(JSON.stringify([domain, id, site, 1])));
    const content = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
    const ciphertext = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), content.toString('base64')].join('.');
    const rpc = jest.fn().mockResolvedValue({ data: { version: 1, ciphertext }, error: null });
    expect((await createHostStateStore({ rpc }, key).load(id, site, 'worker')).configuration).toEqual(config);
    await expect(createHostStateStore({ rpc }, '').save(id, site, 'worker', 0, config)).rejects.toMatchObject({ code: 'encryption' });
  });

  it('never propagates database details or retries unavailable writes', async () => {
    const config = configuration(); const key = randomBytes(32).toString('hex');
    const rpc = jest.fn().mockRejectedValue(new Error(JSON.stringify(config)));
    const result = await createHostStateStore({ rpc }, key).save(randomUUID(), randomUUID(), 'worker', 0, config).catch(error => error);
    expect(result.code).toBe('storage');
    for (const value of config.redactionValues) expect(String(result).includes(value)).toBe(false);
    expect(result.cause).toBeUndefined(); expect(rpc).toHaveBeenCalledTimes(1);
  });
});