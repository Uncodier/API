import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { VideoJobs } from './jobs.mjs';
import { LOCAL_RUNTIME, MAX_CONTENT_BYTES, runVideoJob, runOnce, workerConfig } from './worker.mjs';

// This is deliberately only a container-header fixture, NOT generated/decodable video.
const fixture = Buffer.alloc(24);
fixture.writeUInt32BE(24, 0);
fixture.write('ftypisom', 4);
const request = { prompt: 'A tree in the rain', model: 'h3-base', duration_seconds: 4,
  aspect_ratio: '16:9', resolution: '768p' };

async function harness(input = request) {
  const records = new Map();
  const calls = [];
  let revision = 0;
  const store = {
    async get(key) { return structuredClone(records.get(key) ?? null); },
    async put(key, value, options) {
      const old = records.get(key);
      if ((options.ifNoneMatch && old) || (options.etag !== undefined && options.etag !== old?.etag)) {
        throw Object.assign(new Error('conflict'), { status: 412 });
      }
      const etag = String(++revision);
      records.set(key, { value: structuredClone(value), etag });
      return { etag };
    },
    async enqueue() {},
    async uploadContent(id, bytes) { calls.push(['upload', id, Buffer.from(bytes)]); },
    async receive(options) { calls.push(['receive', options]); return []; },
    async deleteMessage(...args) { calls.push(['delete', ...args]); },
  };
  const jobs = new VideoJobs({ store, config: { enabled: true, leaseMs: 60_000 } });
  const job = await jobs.create('test-principal', input, randomUUID());
  return { store, jobs, job, calls, owner: randomUUID(), timeoutMs: 2_000, pollIntervalMs: 1 };
}

test('offline SGLang HTTP contract and worker failure safety', async t => {
  let route;
  let seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, path: req.url, body });
    route(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(30010, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const send = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  function success(req, res) {
    if (req.method === 'POST') return send(res, { id: 'runtime_1' });
    if (req.url.endsWith('/content')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      return res.end(fixture);
    }
    send(res, { id: 'runtime_1', status: 'completed' });
  }
  const posts = () => seen.filter(x => x.method === 'POST');

  await t.test('genuine HTTP orchestration, exact payload, upload before complete, no fabricated output', async () => {
    seen = [];
    let polls = 0;
    route = (req, res) => {
      if (req.method === 'GET' && !req.url.endsWith('/content') && polls++ === 0) return send(res, { status: 'in_progress' });
      success(req, res);
    };
    const h = await harness();
    // Caller prompt cannot override the durable claimed request.
    h.job.request.prompt = 'ignored';
    const result = await runVideoJob(h);
    assert.equal(result.status, 'completed');
    assert.equal(posts().length, 1);
    assert.deepEqual(JSON.parse(posts()[0].body), {
      task: 't2va', prompt: request.prompt, conditions: [],
      target: { short_edge: 768, aspect_ratio: '16:9', duration_seconds: 4 },
      seed: 0,
    });
    assert.deepEqual(seen.map(x => x.path), ['/v1/videos', '/v1/videos/runtime_1', '/v1/videos/runtime_1', '/v1/videos/runtime_1/content']);
    assert.deepEqual(h.calls[0], ['upload', h.job.id, fixture]);
    assert.deepEqual((await h.jobs.get('test-principal', h.job.id)).result, result.metadata);
    assert.equal(result.metadata.sha256, createHash('sha256').update(fixture).digest('hex'));
    assert.equal((await runVideoJob(h)).status, 'unclaimed');
    assert.equal(posts().length, 1);
  });

  await t.test('forwards durable uint32 seeds exactly, never caller overrides or signed truncation', async () => {
    route = success;
    for (const seed of [0, 1, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff]) {
      seen = [];
      const h = await harness({ ...request, seed });
      h.job.request.seed = seed === 0 ? 1 : 0;
      assert.equal((await runVideoJob(h)).status, 'completed');
      assert.equal(posts().length, 1);
      assert.equal(JSON.parse(posts()[0].body).seed, seed);
      assert.equal((await runVideoJob(h)).status, 'unclaimed');
      assert.equal(posts().length, 1);
    }
  });

  await t.test('invalid or missing durable seeds fail before submitting inference', async () => {
    route = success;
    for (const seed of [undefined, null, '1', true, -1, 0x1_0000_0000, 1.5, NaN, Infinity]) {
      seen = [];
      const h = await harness();
      const claim = h.jobs.claim.bind(h.jobs);
      h.jobs.claim = async (...args) => {
        const claimed = await claim(...args);
        if (claimed) claimed.request.seed = seed;
        return claimed;
      };
      const result = await runVideoJob(h);
      assert.deepEqual([result.status, result.code], ['failed', 'worker_failed']);
      assert.equal(seen.length, 0);
      assert.equal(h.calls.length, 0);
      assert.equal((await runVideoJob(h)).status, 'unclaimed');
    }
  });

  await t.test('ambiguous POST disconnect cannot trigger duplicate inference on redelivery', async () => {
    seen = [];
    route = (req) => req.socket.destroy();
    const h = await harness();
    const result = await runVideoJob(h);
    assert.equal(result.status, 'failed');
    assert.equal((await runVideoJob(h)).status, 'unclaimed');
    assert.equal(posts().length, 1);
    assert.equal(h.calls.length, 0);
  });

  await t.test('poll and response body stalls are aborted within finite budget', async () => {
    for (const mode of ['poll', 'body']) {
      seen = [];
      route = (req, res) => {
        if (mode === 'poll' && req.method === 'GET') return send(res, { status: 'queued' });
        if (mode === 'body' && req.url.endsWith('/content')) {
          res.writeHead(200, { 'Content-Type': 'video/mp4' });
          res.write(fixture); // Never ends.
          return;
        }
        success(req, res);
      };
      const h = await harness();
      const start = Date.now();
      const result = await runVideoJob({ ...h, timeoutMs: 100, pollIntervalMs: 10 });
      assert.deepEqual([result.status, result.code], ['failed', 'timeout']);
      assert.ok(Date.now() - start < 1_500);
      assert.equal(posts().length, 1);
      assert.equal(h.calls.length, 0);
      assert.equal((await runVideoJob(h)).status, 'unclaimed');
    }
  });

  await t.test('runtime failure details and credentials are never returned or persisted', async () => {
    seen = [];
    const sensitive = Array.from({ length: 4 }, () => randomBytes(24).toString('hex'));
    const url = new URL('https://example.invalid/private');
    url.username = sensitive[0]; url.password = sensitive[1]; url.searchParams.set('token', sensitive[2]);
    route = (req, res) => req.method === 'POST' ? success(req, res) :
      send(res, { status: 'failed', error: { message: `${url.href} ${sensitive[3]}` } });
    const h = await harness();
    const result = await runVideoJob(h);
    assert.deepEqual([result.status, result.code], ['failed', 'inference_failed']);
    const serialized = JSON.stringify([result, await h.jobs.get('test-principal', h.job.id)]);
    for (const value of sensitive) assert.ok(!serialized.includes(value));
    assert.equal(h.calls.length, 0);
  });

  await t.test('never follows redirects or attacker-controlled ids/content URLs', async () => {
    for (const mode of ['post-redirect', 'content-redirect', 'id', 'url']) {
      seen = [];
      const remote = new URL('https://example.invalid/private');
      remote.username = randomBytes(16).toString('hex');
      remote.password = randomBytes(16).toString('hex');
      route = (req, res) => {
        if ((mode === 'post-redirect' && req.method === 'POST') || (mode === 'content-redirect' && req.url.endsWith('/content'))) {
          res.writeHead(302, { Location: remote.href }); return res.end();
        }
        if (mode === 'id' && req.method === 'POST') return send(res, { id: '../other' });
        if (mode === 'url' && req.method === 'GET' && !req.url.endsWith('/content')) return send(res, { status: 'completed', url: remote.href });
        success(req, res);
      };
      const h = await harness();
      const result = await runVideoJob({ ...h, fetchImpl: (url, options) => {
        assert.equal(new URL(url).origin, LOCAL_RUNTIME);
        assert.equal(options.redirect, 'error');
        return fetch(url, options);
      } });
      assert.equal(result.status, mode === 'url' ? 'completed' : 'failed');
      assert.equal(posts().length, 1);
      for (const value of [remote.username, remote.password]) assert.ok(!JSON.stringify(result).includes(value));
    }
  });

  await t.test('rejects declared oversized, streaming oversized, non-MP4 and empty outputs', async () => {
    for (const mode of ['length', 'stream', 'type', 'signature', 'empty']) {
      seen = [];
      route = (req, res) => {
        if (!req.url.endsWith('/content')) return success(req, res);
        res.writeHead(200, { 'Content-Type': mode === 'type' ? 'text/html' : 'video/mp4',
          ...(mode === 'length' ? { 'Content-Length': MAX_CONTENT_BYTES + 1 } : {}) });
        res.end(mode === 'empty' ? Buffer.alloc(0) : mode === 'signature' ? Buffer.alloc(24) : fixture);
      };
      const h = await harness();
      const fetchImpl = mode === 'stream' ? async (url, options) => {
        if (!url.endsWith('/content')) return fetch(url, options);
        let chunks = 0;
        return new Response(new ReadableStream({ pull(controller) {
          if (chunks++ < 101) controller.enqueue(new Uint8Array(1024 * 1024));
          else controller.close();
        } }), { headers: { 'Content-Type': 'video/mp4' } });
      } : fetch;
      const result = await runVideoJob({ ...h, fetchImpl });
      assert.deepEqual([result.status, result.code], ['failed', 'output_invalid']);
      assert.equal(h.calls.length, 0);
    }
  });

  await t.test('claim ambiguity, insufficient lease, upload/complete ambiguity, and concurrent duplicate', async () => {
    route = success;
    for (const phase of ['claim', 'lease', 'upload', 'complete', 'duplicate']) {
      seen = [];
      const h = await harness();
      if (phase === 'claim') {
        const claim = h.jobs.claim.bind(h.jobs);
        h.jobs.claim = async (...args) => { await claim(...args); throw new Error(randomBytes(16).toString('hex')); };
      }
      if (phase === 'lease') h.jobs = new VideoJobs({ store: h.store, config: { enabled: true, leaseMs: 2_000 } });
      if (phase === 'upload') h.store.uploadContent = async () => { throw new Error('storage error'); };
      if (phase === 'complete') {
        const complete = h.jobs.complete.bind(h.jobs);
        h.jobs.complete = async (...args) => { await complete(...args); throw new Error('lost response'); };
      }
      const results = phase === 'duplicate' ? await Promise.all([runVideoJob(h), runVideoJob({ ...h, owner: randomUUID() })]) : [await runVideoJob(h)];
      assert.equal(posts().length, ['claim', 'lease'].includes(phase) ? 0 : 1);
      if (phase === 'duplicate') assert.deepEqual(results.map(r => r.status).sort(), ['completed', 'unclaimed']);
      if (phase === 'claim' || phase === 'complete') assert.equal(results[0].status, 'uncertain');
      if (phase === 'lease' || phase === 'upload') assert.equal(results[0].status, 'failed');
      await runVideoJob(h);
      assert.equal(posts().length, ['claim', 'lease'].includes(phase) ? 0 : 1);
    }
  });

  await t.test('queue receive one; ack durable terminal only; direct ID bypasses queue', async () => {
    route = success;
    const h = await harness();
    const receipt = randomBytes(24).toString('hex');
    h.store.receive = async options => {
      assert.equal(options.maxMessages, 1);
      assert.ok(options.visibilitySeconds >= (h.timeoutMs + 60_000) / 1_000);
      return [{ jobId: h.job.id, messageId: 'message-1', popReceipt: receipt }];
    };
    assert.equal((await runOnce(h)).queueAcknowledged, true);
    assert.deepEqual(h.calls.at(-1), ['delete', 'message-1', receipt]);
    const count = h.calls.length;
    assert.equal((await runOnce(h)).status, 'unclaimed');
    assert.equal(h.calls.length, count);
    const direct = await harness();
    direct.store.receive = () => { throw new Error('must not receive'); };
    assert.equal((await runOnce({ ...direct, jobId: direct.job.id })).status, 'completed');
    assert.equal(direct.calls.filter(c => c[0] === 'delete').length, 0);
    assert.equal((await runOnce(await harness())).status, 'idle');
  });
});

test('time budget covers fetch implementations ignoring abort; no background continuation', async () => {
  const h = await harness();
  let lateResolve;
  let calls = 0;
  const result = await runVideoJob({ ...h, timeoutMs: 20, fetchImpl: () => {
    calls++;
    return new Promise(resolve => { lateResolve = resolve; });
  } });
  assert.deepEqual([result.status, result.code], ['failed', 'timeout']);
  lateResolve(new Response(JSON.stringify({ id: 'late' })));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  assert.equal(h.calls.length, 0);
});

test('cancel before claim prevents inference; invalid bounds rejected', async () => {
  const h = await harness();
  const controller = new AbortController();
  controller.abort();
  const result = await runVideoJob({ ...h, signal: controller.signal,
    fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.deepEqual([result.status, result.code], ['uncertain', 'cancelled']);
  assert.equal((await h.jobs.get('test-principal', h.job.id)).status, 'queued');
  for (const timeoutMs of [0, -1, NaN, Infinity, 3_600_001]) await assert.rejects(runVideoJob({ ...h, timeoutMs }), /invalid_configuration/);
});

test('CLI gates fail closed before any runtime, identity, or storage access', () => {
  for (const env of [{}, { H3_LICENSE_APPROVED: 'true' }, { H3_WORKER_READY: 'true' },
    { H3_LICENSE_APPROVED: 'TRUE', H3_WORKER_READY: 'true' }]) {
    assert.throws(() => workerConfig(env), /worker_not_ready/);
    const child = spawnSync(process.execPath, [new URL('./worker.mjs', import.meta.url).pathname], {
      env, encoding: 'utf8', timeout: 3_000,
    });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, 'video_worker_unavailable\n');
  }
  const env = { H3_LICENSE_APPROVED: 'true', H3_WORKER_READY: 'true' };
  assert.deepEqual(workerConfig(env), { timeoutMs: 900_000, leaseMs: 960_000, jobId: undefined });
  assert.throws(() => workerConfig({ ...env, VIDEO_JOB_LEASE_MS: '900000' }), /invalid_configuration/);
});