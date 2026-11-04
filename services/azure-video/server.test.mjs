import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createVideoServer } from './server.mjs';

test('fails closed when authentication is not configured', () => {
  for (const tokenHash of ['', 'invalid', undefined]) {
    assert.throws(() => createVideoServer({ tokenHash }), /SHA-256/);
  }
});

test('smoke test rejects malformed credentials without exposing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-smoke-'));
  const parts = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  try {
    const file = join(directory, 'token');
    await writeFile(file, parts.join('\n'), { mode: 0o600 });
    const result = spawnSync('python3', [new URL('./smoke.py', import.meta.url).pathname,
      '--endpoint', 'https://video.example.invalid', '--token-file', file], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.match(output, /Invalid credential file format/);
    for (const part of parts) assert.equal(output.includes(part), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('foundation never advertises or submits an unavailable model', async (t) => {
  const token = randomBytes(32).toString('hex');
  const server = createVideoServer({ tokenHash: createHash('sha256').update(token).digest('hex') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${token}` };
  for (const path of ['/v1/models', '/v1/videos/models', '/readyz', '/v1/videos/test/content']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 401);
  }
  assert.equal((await fetch(origin + '/healthz')).status, 200);
  for (const prefix of ['/v1', '/api/v1']) {
    for (const suffix of ['/models', '/videos/models']) {
      const response = await fetch(origin + prefix + suffix, { headers: auth });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, []);
    }
    const response = await fetch(origin + prefix + '/videos', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'minimax-h3-base', prompt: token }),
    });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text.includes(token), false);
    assert.equal(JSON.parse(text).error.code, 'generation_not_enabled');
    assert.equal((await fetch(origin + prefix + '/videos/test', { headers: auth })).status, 404);
    assert.equal((await fetch(origin + prefix + '/videos/test/content', { headers: auth })).status, 404);
  }
  const readiness = await fetch(origin + '/readyz', { headers: auth });
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json()).generation_enabled, false);
  const wrong = randomBytes(32).toString('hex');
  const rejected = await fetch(origin + '/v1/models', { headers: { Authorization: `Bearer ${wrong}` } });
  assert.equal(rejected.status, 401);
  const body = await rejected.text();
  assert.equal(body.includes(wrong), false);
  assert.equal(body.includes(token), false);
});