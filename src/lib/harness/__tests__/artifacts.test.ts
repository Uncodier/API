import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ARTIFACT_MAX_BYTES, ARTIFACT_PAGE_MAX_CHARS, createArtifactStore, createMemoryArtifactStore } from '../artifact-store';
import { createMemorySessionStore } from '../memory-store';
import { createSession, sessionRequestSchema } from '../session';
import { createRedactor } from '../security';

async function fixture() {
  let now = 1000;
  const sessions = createMemorySessionStore({ now: () => now });
  const initial = createSession(sessionRequestSchema.parse({ objective: 'Offline artifact test', repository: { url: 'https://repo.example.invalid/repository' } }));
  const site = randomUUID();
  await sessions.create(initial, { siteId: site, userId: randomUUID() });
  await sessions.claim(initial.id, site, 'worker', 180);
  return { sessions, id: initial.id, site, store: createMemoryArtifactStore(sessions), expire: () => { now += 181_000; } };
}

describe('complete redacted result artifacts', () => {
  it('retains complete output and late tail with JS UTF-16 offsets across memory adapter reconstruction', async () => {
    const f = await fixture();
    const username = randomBytes(16).toString('hex'), password = randomBytes(24).toString('hex'), token = randomBytes(32).toString('hex');
    const url = new URL('https://db.example.invalid/path'); url.username = username; url.password = password;
    const raw = `prefix ${url.toString()}\n${'😀α'.repeat(20_000)}\nACCESS_TOKEN=${token}\nTAIL_COMPLETE`;
    const text = createRedactor([username, password, token])(raw);
    const op = randomUUID(); await f.store.reserve(f.id, f.site, 'worker', op, ARTIFACT_MAX_BYTES);
    const result = await f.store.put(f.id, f.site, 'worker', op, text);
    expect(result).toEqual({ id: createHash('sha256').update(f.id).update('\0').update(op).update('\0').update(text).digest('hex'), bytes: Buffer.byteLength(text), chars: text.length });
    expect(await f.store.put(f.id, f.site, 'worker', op, text)).toEqual(result);
    await f.sessions.release(f.id, f.site, 'worker'); await f.sessions.claim(f.id, f.site, 'next', 180);
    const recreated = createMemoryArtifactStore(f.sessions);
    let output = '', offset: number | null = 0;
    while (offset !== null) {
      const page = await recreated.read(f.id, f.site, 'next', result.id, offset, ARTIFACT_PAGE_MAX_CHARS);
      expect(page!.text.length).toBeLessThanOrEqual(ARTIFACT_PAGE_MAX_CHARS);
      expect(page!.totalChars).toBe(text.length);
      output += page!.text; offset = page!.nextOffset;
    }
    expect(output === text).toBe(true); expect(output.endsWith('TAIL_COMPLETE')).toBe(true);
    for (const secret of [username, password, token]) expect(output.includes(secret)).toBe(false);
    const surrogate = text.indexOf('😀') + 1;
    expect((await recreated.read(f.id, f.site, 'next', result.id, surrogate, 1))!.text).toBe(text.slice(surrogate, surrogate + 1));
    expect(await recreated.read(f.id, f.site, 'next', result.id, text.length + 1, 10)).toEqual({ text: '', totalChars: text.length, nextOffset: null });
  });

  it('uses session/operation/content bound IDs and scopes every read, put and reservation to a current running owner', async () => {
    const f = await fixture(); const op = randomUUID();
    const result = await f.store.put(f.id, f.site, 'worker', op, 'complete');
    expect((await f.store.put(f.id, f.site, 'worker', randomUUID(), 'complete')).id).not.toBe(result.id);
    expect((await f.store.put(f.id, f.site, 'worker', op, 'different')).id).not.toBe(result.id);
    for (const [id, site, owner] of [[randomUUID(), f.site, 'worker'], [f.id, randomUUID(), 'worker'], [f.id, f.site, 'old']]) {
      await expect(f.store.reserve(id, site, owner, op, 1)).rejects.toMatchObject({ code: 'conflict' });
      await expect(f.store.put(id, site, owner, op, 'text')).rejects.toMatchObject({ code: 'conflict' });
      await expect(f.store.read(id, site, owner, result.id, 0, 10)).rejects.toMatchObject({ code: 'conflict' });
    }
    expect(await f.store.read(f.id, f.site, 'worker', '0'.repeat(64), 0, 10)).toBeNull();
    f.expire();
    await expect(f.store.read(f.id, f.site, 'worker', result.id, 0, 10)).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.store.put(f.id, f.site, 'worker', op, 'text')).rejects.toMatchObject({ code: 'conflict' });
    await f.sessions.claim(f.id, f.site, 'next', 180); await f.sessions.control(f.id, f.site, 'pause');
    await expect(f.store.reserve(f.id, f.site, 'next', op, 1)).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.store.read(f.id, f.site, 'next', result.id, 0, 10)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects overflow before effects, reserves idempotently, releases unused capacity and retains existing data at full quota', async () => {
    const f = await fixture(); const text = 'x'.repeat(ARTIFACT_MAX_BYTES); const op = randomUUID();
    await expect(f.store.put(f.id, f.site, 'worker', op, text + 'x')).rejects.toMatchObject({ code: 'quota' });
    await expect(f.store.put(f.id, f.site, 'worker', op, '😀'.repeat(ARTIFACT_MAX_BYTES / 4) + 'x')).rejects.toMatchObject({ code: 'quota' });
    await f.store.reserve(f.id, f.site, 'worker', op, ARTIFACT_MAX_BYTES);
    await f.store.reserve(f.id, f.site, 'worker', op, ARTIFACT_MAX_BYTES);
    const first = await f.store.put(f.id, f.site, 'worker', op, 'small');
    for (let n = 0; n < 15; n++) await f.store.put(f.id, f.site, 'worker', `op-${n}`, text);
    // Small actual content released almost all of its reservation.
    const lastOp = randomUUID(); await f.store.reserve(f.id, f.site, 'worker', lastOp, ARTIFACT_MAX_BYTES - 5);
    const effect = jest.fn();
    await expect((async () => { await f.store.reserve(f.id, f.site, 'worker', randomUUID(), 1); effect(); })()).rejects.toMatchObject({ code: 'quota' });
    expect(effect).not.toHaveBeenCalled();
    await f.store.put(f.id, f.site, 'worker', lastOp, text.slice(5));
    await expect(f.store.put(f.id, f.site, 'worker', randomUUID(), 'x')).rejects.toMatchObject({ code: 'quota' });
    expect(await f.store.put(f.id, f.site, 'worker', op, 'small')).toEqual(first);
    expect((await f.store.read(f.id, f.site, 'worker', first.id, 0, 20))!.text).toBe('small');
  });

  it('validates character limits, malformed Unicode, offsets and operation IDs without truncation', async () => {
    const f = await fixture(); const result = await f.store.put(f.id, f.site, 'worker', randomUUID(), '');
    expect(result.bytes).toBe(0); expect(result.chars).toBe(0);
    for (const [offset, limit] of [[-1, 2], [0.1, 2], [NaN, 2], [0, 0], [0, ARTIFACT_PAGE_MAX_CHARS + 1], [0, Infinity]]) {
      await expect(f.store.read(f.id, f.site, 'worker', result.id, offset, limit)).rejects.toMatchObject({ code: 'invalid' });
    }
    for (const text of ['\ud800', '\0']) await expect(f.store.put(f.id, f.site, 'worker', randomUUID(), text)).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.store.put(f.id, f.site, 'worker', '', 'text')).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.store.reserve(f.id, f.site, 'worker', randomUUID(), ARTIFACT_MAX_BYTES + 1)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('durable adapter slices in JS rather than SQL, preserves tail and rejects unconfirmed writes without auto-retry', async () => {
    const id = randomUUID(), site = randomUUID(), operation = randomUUID(); const text = '😀'.repeat(9000) + 'TAIL';
    const rpc = jest.fn(async (name: string, args: Record<string, unknown>) => ({ error: null,
      data: name === 'reserve_harness_artifact' ? true : name === 'put_harness_artifact' ? { id: args.p_artifact_id, chars: text.length, bytes: Buffer.byteLength(text) } : { text } }));
    const store = createArtifactStore({ rpc }); await store.reserve(id, site, 'worker', operation, ARTIFACT_MAX_BYTES);
    const result = await store.put(id, site, 'worker', operation, text);
    const tail = await store.read(id, site, 'worker', result.id, 17_999, 16_000);
    expect(tail).toEqual({ text: text.slice(17_999), totalChars: text.length, nextOffset: null });
    expect(rpc).toHaveBeenLastCalledWith('read_harness_artifact', { p_id: id, p_site_id: site, p_owner: 'worker', p_artifact_id: result.id });
    const unavailable = jest.fn().mockRejectedValue(new Error(randomBytes(32).toString('hex')));
    await expect(createArtifactStore({ rpc: unavailable }).put(id, site, 'worker', operation, 'output')).rejects.toThrow('do not repeat side effects');
    expect(unavailable).toHaveBeenCalledTimes(1);
    const quota = jest.fn().mockResolvedValue({ data: null, error: { code: '54000' } });
    await expect(createArtifactStore({ rpc: quota }).reserve(id, site, 'worker', operation, 1)).rejects.toMatchObject({ code: 'quota' });
    expect(quota).toHaveBeenCalledTimes(1);
  });
});