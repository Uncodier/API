import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { VideoJobs } from './jobs.mjs';

const synthetic = () => randomBytes(24).toString('hex');
const input = { prompt: 'A paper boat on a quiet lake', seconds: 4 };
const code = (expected, status) => (cause) => {
  assert.equal(cause.code, expected);
  assert.equal(cause.status, status);
  assert.equal(cause.message, expected);
  assert.equal(cause.cause, undefined);
  return true;
};

class MemoryStore {
  records = new Map();
  messages = [];
  version = 0;
  async get(key) { return structuredClone(this.records.get(key) ?? null); }
  async put(key, value, options) {
    const existing = this.records.get(key);
    if ((options.ifNoneMatch && existing) || (!options.ifNoneMatch && existing?.etag !== options.etag)) {
      throw Object.assign(new Error('conflict'), { status: this.version % 2 ? 409 : 412 });
    }
    assert.ok(options.ifNoneMatch === true || typeof options.etag === 'string');
    const etag = String(++this.version);
    this.records.set(key, { value: structuredClone(value), etag });
    return { etag };
  }
  async enqueue(id) { this.messages.push(id); }
}

function fixture(config = {}) {
  const store = new MemoryStore();
  const principal = synthetic();
  const key = synthetic();
  const owner = synthetic();
  let now = 1_000;
  const options = { store, clock: () => now, config: { enabled: true, leaseMs: 100, ...config } };
  return { store, principal, key, owner, options, jobs: new VideoJobs(options), advance: (ms) => { now += ms; } };
}

function metadata(id) {
  // Synthetic artifact metadata, not generated video/inference.
  return { content_key: `videos/${id}.mp4`, content_type: 'video/mp4', size_bytes: 123,
    sha256: createHash('sha256').update(randomBytes(32)).digest('hex') };
}

test('disabled is fail-closed, including claim; reads remain possible', async () => {
  const f = fixture({ enabled: false });
  await assert.rejects(f.jobs.create(f.principal, input, f.key), code('generation_not_enabled', 503));
  await assert.rejects(f.jobs.claim('anything', f.owner), code('generation_not_enabled', 503));
  assert.equal(f.store.records.size, 0);
  const disabledDefault = new VideoJobs({ store: f.store });
  await assert.rejects(disabledDefault.create(f.principal, input, f.key), code('generation_not_enabled', 503));
});

test('normalization, durable replay across instances, tenant isolation, and immutable projections', async () => {
  const f = fixture();
  const created = await f.jobs.create(f.principal, { ...input, prompt: ` ${input.prompt} ` }, f.key);
  assert.match(created.id, /^video_[a-f0-9]{64}$/);
  assert.deepEqual(created.request, { prompt: input.prompt, model: 'h3-base', duration_seconds: 4,
    aspect_ratio: '16:9', resolution: '768p', seed: 0 });
  assert.equal(created.status, 'queued');
  assert.equal(created.attempts, 0);
  assert.equal(created.created_at, 1_000);
  assert.deepEqual(Object.keys(created).sort(), ['id', 'status', 'request', 'created_at', 'updated_at', 'attempts'].sort());
  const restarted = new VideoJobs(f.options);
  for (const alias of ['duration', 'seconds', 'duration_seconds']) {
    assert.deepEqual(await restarted.create(f.principal, { prompt: input.prompt, [alias]: '4' }, f.key), created);
  }
  assert.equal(f.store.messages.length, 1);
  const other = synthetic();
  await assert.rejects(restarted.get(other, created.id), code('video_not_found', 404));
  const differentTenant = await restarted.create(other, input, f.key);
  assert.notEqual(differentTenant.id, created.id);
  created.request.prompt = 'mutated';
  assert.equal((await restarted.get(f.principal, created.id)).request.prompt, input.prompt);
  await assert.rejects(restarted.get(f.principal, '../escape'), code('video_not_found', 404));
});

test('idempotency key required; changed request cannot replace first durable submission', async () => {
  const f = fixture();
  for (const key of [undefined, null, '', ' ', 42, 'x'.repeat(257)]) {
    await assert.rejects(f.jobs.create(f.principal, input, key), code('idempotency_key_required', 400));
  }
  const first = await f.jobs.create(f.principal, input, f.key);
  for (const changed of [{ ...input, prompt: 'different' }, { ...input, seconds: 5 }, { ...input, aspect_ratio: '9:16' }]) {
    await assert.rejects(f.jobs.create(f.principal, changed, f.key), code('idempotency_conflict', 409));
  }
  assert.equal(f.store.records.size, 1);
  assert.deepEqual(await f.jobs.get(f.principal, first.id), first);
});

test('strict JSON validation rejects unsupported references and does not silently drop fields', async () => {
  const f = fixture();
  const cases = [
    [null, 'unsupported_fields'], [[], 'unsupported_fields'], [new Date(), 'unsupported_fields'],
    [{ ...input, references: [] }, 'unsupported_fields'], [{ ...input, image: 'https://example.invalid/a' }, 'unsupported_fields'],
    [{ ...input, size: '768x768' }, 'unsupported_fields'], [{ ...input, unknown: 1 }, 'unsupported_fields'],
    [{ ...input, prompt: '' }, 'invalid_prompt'], [{ ...input, prompt: '  ' }, 'invalid_prompt'],
    [{ ...input, prompt: 'x'.repeat(10_001) }, 'invalid_prompt'], [{ ...input, prompt: 1 }, 'invalid_prompt'],
    [{ ...input, model: 'minimax/h3-base' }, 'unsupported_model'], [{ ...input, model: null }, 'unsupported_model'],
    [{ prompt: input.prompt }, 'invalid_duration'], [{ ...input, duration: 5 }, 'invalid_duration'],
    [{ ...input, resolution: '1080p' }, 'unsupported_resolution'], [{ ...input, resolution: null }, 'unsupported_resolution'],
    [{ ...input, aspect_ratio: '2:1' }, 'unsupported_aspect_ratio'], [{ ...input, aspect_ratio: null }, 'unsupported_aspect_ratio'],
  ];
  for (const seconds of [null, undefined, true, [], {}, 0, 3, 16, 4.5, NaN, Infinity, '4.0', '04', ' 4', '4s']) {
    cases.push([{ ...input, seconds }, 'invalid_duration']);
  }
  for (const [request, expected] of cases) {
    await assert.rejects(f.jobs.create(f.principal, request, f.key), code(expected, 400));
  }
  assert.equal(f.store.records.size, 0);
  assert.equal(f.store.messages.length, 0);
  for (const aspect_ratio of ['16:9', '9:16', '1:1']) {
    assert.equal((await f.jobs.create(f.principal, { ...input, seconds: 15, aspect_ratio }, synthetic())).request.duration_seconds, 15);
  }
  assert.equal((await f.jobs.create(f.principal, { ...input, duration: '4', duration_seconds: 4 }, f.key)).request.duration_seconds, 4);
});

test('duration cap and single attempt are explicit limited work constraints', async () => {
  const f = fixture({ maxDurationSeconds: 4 });
  await assert.rejects(f.jobs.create(f.principal, { ...input, seconds: 5 }, f.key), code('duration_budget_exceeded', 400));
  assert.equal(f.store.records.size, 0);
  for (const config of [{ maxDurationSeconds: 3 }, { maxDurationSeconds: 16 }, { maxDurationSeconds: 4.5 },
    { leaseMs: 0 }, { leaseMs: Infinity }, { maxAttempts: 2 }, { enabled: 'true' },
    { queueTimeoutMs: 0 }, { queueTimeoutMs: 86_400_001 }, { queueTimeoutMs: 1.5 }, { queueTimeoutMs: null }]) {
    assert.throws(() => new VideoJobs({ ...f.options, config }), code('invalid_configuration', 500));
  }
  assert.throws(() => new VideoJobs(), code('invalid_configuration', 500));
  const badClock = new VideoJobs({ ...f.options, clock: () => NaN });
  await assert.rejects(badClock.create(f.principal, input, f.key), code('invalid_clock', 500));
});

test('concurrent duplicate submissions and deliveries authorize exactly one worker', async () => {
  const f = fixture();
  const jobs = await Promise.all(Array.from({ length: 24 }, () => new VideoJobs(f.options).create(f.principal, input, f.key)));
  assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
  assert.equal(f.store.records.size, 1);
  const id = jobs[0].id;
  const claims = await Promise.all(Array.from({ length: 24 }, () => new VideoJobs(f.options).claim(id, synthetic())));
  const winners = claims.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].attempts, 1);
  assert.equal(winners[0].status, 'in_progress');
  assert.equal(winners[0].lease_expires_at, 1_100);
  assert.equal((await f.jobs.get(f.principal, id)).lease_expires_at, undefined);
  assert.equal(await f.jobs.claim(id, f.owner), null);
});

test('queue failure, ambiguous enqueue acceptance, and lost marker each recover on duplicate', async () => {
  for (const mode of ['before-enqueue', 'after-enqueue', 'marker']) {
    const f = fixture();
    const secret = synthetic();
    const enqueue = f.store.enqueue.bind(f.store);
    const put = f.store.put.bind(f.store);
    let failOnce = true;
    f.store.enqueue = async (id) => {
      if (mode !== 'marker' && failOnce) {
        failOnce = false;
        if (mode === 'after-enqueue') await enqueue(id);
        throw new Error(secret);
      }
      await enqueue(id);
    };
    f.store.put = async (key, job, options) => {
      if (mode === 'marker' && job.queue === 'published' && failOnce) {
        failOnce = false;
        throw new Error(secret);
      }
      return put(key, job, options);
    };
    await assert.rejects(f.jobs.create(f.principal, input, f.key), code(mode === 'marker' ? 'storage_unavailable' : 'queue_unavailable', 503));
    assert.equal(f.store.records.size, 1);
    assert.equal([...f.store.records.values()][0].value.queue, 'pending');
    const recovered = await new VideoJobs(f.options).create(f.principal, input, f.key);
    assert.equal([...f.store.records.values()][0].value.queue, 'published');
    assert.ok(f.store.messages.every((id) => id === recovered.id));
    assert.equal(f.store.messages.length, mode === 'before-enqueue' ? 1 : 2);
    assert.equal(JSON.stringify([...f.store.records]).includes(secret), false);
  }
});

test('ambiguous committed create and claim never allocate another job or authorize another inference', async () => {
  const f = fixture();
  const put = f.store.put.bind(f.store);
  let brokenState = 'queued';
  f.store.put = async (key, job, options) => {
    const result = await put(key, job, options);
    if (job.status === brokenState) { brokenState = null; throw new Error(synthetic()); }
    return result;
  };
  await assert.rejects(f.jobs.create(f.principal, input, f.key), code('storage_unavailable', 503));
  const originalId = [...f.store.records.values()][0].value.id;
  const recovered = await f.jobs.create(f.principal, input, f.key);
  assert.equal(recovered.id, originalId);
  assert.equal(f.store.records.size, 1);
  brokenState = 'in_progress';
  await assert.rejects(f.jobs.claim(originalId, f.owner), code('storage_unavailable', 503));
  assert.equal(await f.jobs.claim(originalId, f.owner), null);
  f.advance(100);
  assert.equal(await f.jobs.claim(originalId, synthetic()), null);
  const failed = await f.jobs.get(f.principal, originalId);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, { code: 'execution_ambiguous' });
  assert.equal(failed.attempts, 1);
});

test('active owner can complete actual artifact metadata; other owners and repeated claims cannot', async () => {
  const f = fixture();
  const { id } = await f.jobs.create(f.principal, input, f.key);
  await assert.rejects(f.jobs.complete(id, f.owner, metadata(id)), code('lease_lost', 409));
  await f.jobs.claim(id, f.owner);
  assert.equal(await f.jobs.claim(id, f.owner), null);
  await assert.rejects(f.jobs.complete(id, synthetic(), metadata(id)), code('lease_lost', 409));
  await assert.rejects(f.jobs.fail(id, synthetic(), 'timeout'), code('lease_lost', 409));
  f.advance(99);
  const result = metadata(id);
  const completed = await f.jobs.complete(id, f.owner, result);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, result);
  assert.equal(completed.updated_at, 1_099);
  assert.equal(await f.jobs.claim(id, f.owner), null);
  await assert.rejects(f.jobs.fail(id, f.owner, 'timeout'), code('lease_lost', 409));
  assert.deepEqual(await f.jobs.create(f.principal, input, f.key), completed);
  assert.equal(f.store.messages.length, 1);
});

test('expired workers fail at exact deadline via get, claim, complete or fail; never reclaimed', async () => {
  for (const operation of ['get', 'claim', 'complete', 'fail']) {
    const f = fixture();
    const { id } = await f.jobs.create(f.principal, input, f.key);
    await f.jobs.claim(id, f.owner);
    f.advance(100);
    if (operation === 'get') assert.equal((await f.jobs.get(f.principal, id)).status, 'failed');
    if (operation === 'claim') assert.equal(await f.jobs.claim(id, synthetic()), null);
    if (operation === 'complete') await assert.rejects(f.jobs.complete(id, f.owner, metadata(id)), code('lease_lost', 409));
    if (operation === 'fail') await assert.rejects(f.jobs.fail(id, f.owner, 'timeout'), code('lease_lost', 409));
    assert.equal((await f.jobs.get(f.principal, id)).error.code, 'execution_ambiguous');
    assert.equal(await f.jobs.claim(id, f.owner), null);
    assert.equal((await f.jobs.create(f.principal, input, f.key)).status, 'failed');
  }
});

test('failure is terminal, with finite sanitized error codes, no raw secrets persisted or projected', async () => {
  const f = fixture();
  const username = synthetic(), password = synthetic(), token = synthetic();
  const url = new URL('https://example.invalid/error');
  url.username = username;
  url.password = password;
  url.searchParams.set('token', token);
  const { id } = await f.jobs.create(f.principal, input, f.key);
  await f.jobs.claim(id, f.owner);
  const activeRecord = JSON.stringify([...f.store.records]);
  for (const secret of [f.principal, f.key, f.owner]) assert.equal(activeRecord.includes(secret), false);
  const failed = await f.jobs.fail(id, f.owner, new Error(url.href));
  assert.deepEqual(failed.error, { code: 'worker_failed' });
  const serialized = JSON.stringify({ records: [...f.store.records], messages: f.store.messages, failed });
  for (const secret of [f.principal, f.key, f.owner, username, password, token]) assert.equal(serialized.includes(secret), false);
  assert.equal(await f.jobs.claim(id, f.owner), null);
  await assert.rejects(f.jobs.complete(id, f.owner, metadata(id)), code('lease_lost', 409));
  const second = await f.jobs.create(f.principal, input, synthetic());
  await f.jobs.claim(second.id, f.owner);
  assert.equal((await f.jobs.fail(second.id, f.owner, 'timeout')).error.code, 'timeout');
});

test('completion rejects arbitrary metadata, URLs, zero-sized artifacts and credential-bearing strings', async () => {
  const f = fixture();
  const { id } = await f.jobs.create(f.principal, input, f.key);
  await f.jobs.claim(id, f.owner);
  const username = synthetic(), password = synthetic(), token = synthetic();
  const url = new URL('https://example.invalid/video.mp4');
  url.username = username;
  url.password = password;
  url.searchParams.set('token', token);
  for (const invalid of [null, {}, { ...metadata(id), content_key: url.href }, { ...metadata(id), extra: token },
    { ...metadata(id), size_bytes: 0 }, { ...metadata(id), size_bytes: Infinity },
    { ...metadata(id), content_type: 'text/html' }, { ...metadata(id), sha256: token },
    { ...metadata(id), content_key: `videos/../${id}.mp4` }]) {
    await assert.rejects(f.jobs.complete(id, f.owner, invalid), code('invalid_metadata', 400));
  }
  const persisted = JSON.stringify([...f.store.records]);
  for (const secret of [username, password, token]) assert.equal(persisted.includes(secret), false);
  assert.equal((await f.jobs.get(f.principal, id)).status, 'in_progress');
});

test('enqueue-to-claim race cannot overwrite worker state with queued marker', async () => {
  const f = fixture();
  f.store.enqueue = async (id) => {
    f.store.messages.push(id);
    assert.equal((await new VideoJobs(f.options).claim(id, f.owner)).status, 'in_progress');
  };
  const job = await f.jobs.create(f.principal, input, f.key);
  assert.equal(job.status, 'in_progress');
  assert.equal(job.attempts, 1);
  assert.equal(f.store.messages.length, 1);
  assert.equal(await f.jobs.claim(job.id, synthetic()), null);
});

test('CAS contention is bounded; adapter errors are never exposed', async () => {
  const f = fixture();
  let writes = 0;
  f.store.put = async () => { writes++; throw Object.assign(new Error(synthetic()), { statusCode: 412 }); };
  await assert.rejects(f.jobs.create(f.principal, input, f.key), code('contention', 503));
  assert.equal(writes, 12);
  const secret = synthetic();
  f.store.get = async () => { throw new Error(secret); };
  await assert.rejects(f.jobs.create(f.principal, input, f.key), (cause) => {
    assert.equal(String(cause.stack).includes(secret), false);
    return code('storage_unavailable', 503)(cause);
  });
});

test('competing completion/failure CAS commits exactly one immutable terminal outcome', async () => {
  const f = fixture();
  const { id } = await f.jobs.create(f.principal, input, f.key);
  await f.jobs.claim(id, f.owner);
  const outcomes = await Promise.allSettled([
    f.jobs.complete(id, f.owner, metadata(id)),
    new VideoJobs(f.options).fail(id, f.owner, 'inference_failed'),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'lease_lost');
  const terminal = outcomes.find((outcome) => outcome.status === 'fulfilled').value;
  assert.deepEqual(await f.jobs.get(f.principal, id), terminal);
  assert.equal(await f.jobs.claim(id, synthetic()), null);
});

test('a queued record with a previous attempt fails closed instead of retrying paid work', async () => {
  const f = fixture();
  const { id } = await f.jobs.create(f.principal, input, f.key);
  const current = await f.store.get(`jobs/${id}`);
  await f.store.put(`jobs/${id}`, { ...current.value, attempts: 1 }, { etag: current.etag });
  assert.equal(await f.jobs.claim(id, f.owner), null);
  const failed = await f.jobs.get(f.principal, id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'attempt_limit');
  assert.equal(failed.attempts, 1);
});

test('ambiguous committed completion is resolved by polling, not another inference', async () => {
  const f = fixture();
  const { id } = await f.jobs.create(f.principal, input, f.key);
  await f.jobs.claim(id, f.owner);
  const put = f.store.put.bind(f.store);
  f.store.put = async (key, job, options) => {
    const result = await put(key, job, options);
    if (job.status === 'completed') throw new Error(synthetic());
    return result;
  };
  await assert.rejects(f.jobs.complete(id, f.owner, metadata(id)), code('storage_unavailable', 503));
  assert.equal((await f.jobs.get(f.principal, id)).status, 'completed');
  assert.equal(await f.jobs.claim(id, synthetic()), null);
});

test('seed defaults to zero, participates in idempotency, and accepts only uint32 integers', async () => {
  const f = fixture();
  const first = await f.jobs.create(f.principal, input, f.key);
  assert.equal(first.request.seed, 0);
  assert.deepEqual(await f.jobs.create(f.principal, { ...input, seed: 0 }, f.key), first);
  await assert.rejects(f.jobs.create(f.principal, { ...input, seed: 1 }, f.key), code('idempotency_conflict', 409));
  for (const seed of [1, 0xffff_ffff]) {
    assert.equal((await f.jobs.create(f.principal, { ...input, seed }, synthetic())).request.seed, seed);
  }
  for (const seed of [-1, 0x1_0000_0000, 1.5, null, undefined, false, '1', [], {}, NaN, Infinity]) {
    await assert.rejects(f.jobs.create(f.principal, { ...input, seed }, synthetic()), code('invalid_seed', 400));
  }
});

test('queued timeout is durable, checked at the exact deadline, and cannot be reset by duplicates', async () => {
  for (const operation of ['get', 'claim', 'create']) {
    const f = fixture({ queueTimeoutMs: 100 });
    const first = await f.jobs.create(f.principal, input, f.key);
    const restarted = new VideoJobs({ ...f.options, config: { ...f.options.config, queueTimeoutMs: 100_000 } });
    f.advance(99);
    assert.equal((await restarted.get(f.principal, first.id)).status, 'queued');
    assert.deepEqual(await restarted.create(f.principal, input, f.key), first);
    f.advance(1);
    if (operation === 'get') assert.equal((await restarted.get(f.principal, first.id)).status, 'failed');
    if (operation === 'claim') assert.equal(await restarted.claim(first.id, f.owner), null);
    if (operation === 'create') assert.equal((await restarted.create(f.principal, input, f.key)).status, 'failed');
    const failed = await restarted.get(f.principal, first.id);
    assert.equal(failed.error.code, 'queue_timeout');
    assert.equal(failed.attempts, 0);
    assert.equal(await restarted.claim(first.id, f.owner), null);
    assert.equal(f.store.messages.length, 1);
  }
});

test('expired pending publication is not re-enqueued, and slow publishing returns terminal timeout', async () => {
  for (const slow of [false, true]) {
    const f = fixture({ queueTimeoutMs: 100 });
    f.store.enqueue = async (id) => {
      if (!slow) throw new Error(synthetic());
      f.store.messages.push(id);
      f.advance(100);
    };
    let expired;
    if (slow) expired = await f.jobs.create(f.principal, input, f.key);
    else {
      await assert.rejects(f.jobs.create(f.principal, input, f.key), code('queue_unavailable', 503));
      f.advance(100);
      expired = await f.jobs.create(f.principal, input, f.key);
    }
    assert.equal(expired.status, 'failed');
    assert.equal(expired.error.code, 'queue_timeout');
    assert.equal(await f.jobs.claim(expired.id, f.owner), null);
    assert.equal(f.store.messages.length, slow ? 1 : 0);
  }
});

test('a timely claim follows execution lease, not the old queue deadline', async () => {
  const f = fixture({ queueTimeoutMs: 50, leaseMs: 100 });
  const { id } = await f.jobs.create(f.principal, input, f.key);
  f.advance(49);
  await f.jobs.claim(id, f.owner);
  f.advance(50);
  assert.equal((await f.jobs.get(f.principal, id)).status, 'in_progress');
  assert.equal((await f.jobs.complete(id, f.owner, metadata(id))).status, 'completed');
});