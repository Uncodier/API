import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createVideoServer } from './server.mjs';
import { VideoJobs } from './jobs.mjs';

test('HTTP to durable job lifecycle and content; no actual inference', async t => {
  const records = new Map();
  const queue = [];
  let serial = 0;
  const store = {
    async get(key) { return structuredClone(records.get(key) || null); },
    async put(key, value, condition) {
      const old = records.get(key);
      if ((condition.ifNoneMatch && old) || (condition.etag && old?.etag !== condition.etag)) {
        throw Object.assign(new Error('conflict'), { status: 412 });
      }
      const etag = String(++serial);
      records.set(key, { value: structuredClone(value), etag });
      return { etag };
    },
    async enqueue(id) { queue.push(id); },
    async getContent() { return { body: Buffer.from('synthetic-test-artifact'), contentType: 'video/mp4' }; },
  };
  const jobs = new VideoJobs({ store, config: { enabled: true } });
  const token = randomBytes(32).toString('hex');
  const server = createVideoServer({ tokenHash: createHash('sha256').update(token).digest('hex'), jobs, store, enabled: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
    'Idempotency-Key': randomBytes(24).toString('hex') };
  const input = { model: 'h3-base', prompt: 'A tree moving in the wind', seconds: '4' };
  const post = body => fetch(base + '/v1/videos', { method: 'POST', headers, body: JSON.stringify(body) });
  const submitted = await post(input);
  assert.equal(submitted.status, 202);
  const job = await submitted.json();
  assert.equal(job.status, 'pending');
  assert.equal((await (await post(input)).json()).id, job.id);
  assert.equal(queue.length, 1);
  assert.equal((await post({ ...input, prompt: 'different' })).status, 409);
  assert.equal((await fetch(base + '/v1/videos/' + job.id + '/content', { headers })).status, 409);
  const owner = randomBytes(16).toString('hex');
  assert.ok(await jobs.claim(job.id, owner));
  const progress = await fetch(base + '/api/v1/videos/' + job.id, { headers });
  assert.equal((await progress.json()).status, 'in_progress');
  const bytes = Buffer.from('synthetic-test-artifact');
  await jobs.complete(job.id, owner, { content_key: `videos/${job.id}.mp4`, content_type: 'video/mp4',
    size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const content = await fetch(base + '/v1/videos/' + job.id + '/content', { headers });
  assert.equal(content.status, 200);
  assert.equal(await content.text(), bytes.toString());
  assert.equal((await fetch(base + '/readyz', { headers })).status, 200);
  assert.equal((await post({ ...input, reference_images: ['https://example.invalid/image.png'] })).status, 400);
});