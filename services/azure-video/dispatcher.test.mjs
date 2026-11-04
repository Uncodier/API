import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDispatcher } from './dispatcher.mjs';

function fixture(statuses = [404, 201], overrides = {}) {
  const workspaceId = `/subscriptions/${randomUUID()}/resourceGroups/test/providers/Microsoft.MachineLearningServices/workspaces/video`;
  const digest = randomBytes(32).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const calls = [];
  const config = { workspaceId, environmentId: `${workspaceId}/environments/video-worker/versions/${digest}`,
    workerImage: `registry.example.test/worker@sha256:${digest}`, workerClientId: randomUUID(),
    storageAccount: 'testaccount', licenseProofRef: 'legal:approval/test', modelRevision: randomBytes(20).toString('hex'),
    enabled: true, licenseApproved: true, workerReady: true, tokenProvider: async () => secret,
    fetchImpl: async (url, options) => { calls.push({ url, ...options }); return new Response(null, { status: statuses.shift() }); },
    ...overrides };
  const dispatcher = createDispatcher(config);
  return { config, dispatcher, calls, secret, id: `video_${randomBytes(32).toString('hex')}` };
}

test('CommandJob uses documented ARM schema, fixed runtime, immutable environment and direct worker ID', async () => {
  const { dispatcher, calls, id, config, secret } = fixture();
  assert.equal((await dispatcher.dispatch(id)).submitted, true);
  assert.deepEqual(calls.map(c => c.method), ['GET', 'PUT']);
  assert.equal(calls[0].url, calls[1].url);
  assert.match(calls[1].url, /jobs\/video-[a-f0-9]{64}\?api-version=2024-10-01$/);
  const body = JSON.parse(calls[1].body);
  assert.deepEqual(Object.keys(body), ['properties']);
  assert.equal(body.properties.jobType, 'Command');
  assert.deepEqual(body.properties.limits, { jobLimitsType: 'Command', timeout: 'PT30M' });
  assert.equal(body.properties.command, 'bash /app/start-worker.sh');
  assert.equal(body.properties.environmentId, config.environmentId);
  assert.equal(body.properties.environmentVariables.VIDEO_JOB_ID, id);
  assert.equal(body.properties.environmentVariables.VIDEO_STORAGE_IDENTITY, 'imds');
  assert.equal(body.properties.resources.instanceCount, 1);
  assert.equal(calls[1].headers['If-None-Match'], '*');
  assert.equal(calls[1].body.includes(secret), false);
});

test('existing AML job, including terminal job, is never resubmitted', async () => {
  const { dispatcher, calls, id } = fixture([200]);
  assert.equal((await dispatcher.dispatch(id)).existing, true);
  assert.deepEqual(calls.map(c => c.method), ['GET']);
});

test('concurrent local dispatches share one create; race conflict reconciles with GET', async () => {
  const { dispatcher, calls, id } = fixture([404, 409, 200]);
  const results = await Promise.all([dispatcher.dispatch(id), dispatcher.dispatch(id)]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(calls.map(c => c.method), ['GET', 'PUT', 'GET']);
});

test('authorization and transient GET errors never PUT', async () => {
  for (const status of [401, 403, 429, 500, 302]) {
    const { dispatcher, calls, id } = fixture([status]);
    await assert.rejects(dispatcher.dispatch(id), { code: 'ARM_LOOKUP_FAILED' });
    assert.equal(calls.length, 1);
  }
});

test('uncertain PUT has no blind retry; repeated same ID reconciles with GET', async () => {
  const f = fixture([404, 500, 200]);
  await assert.rejects(f.dispatcher.dispatch(f.id), { code: 'ARM_SUBMIT_FAILED' });
  assert.equal((await f.dispatcher.dispatch(f.id)).existing, true);
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'PUT', 'GET']);
});

test('fail closed on gates and malformed IDs without network', async () => {
  for (const flag of ['enabled', 'licenseApproved', 'workerReady']) {
    for (const value of [false, 'false', 'true']) {
      const f = fixture([], { [flag]: value });
      await assert.rejects(f.dispatcher.dispatch(f.id), { code: 'GENERATION_NOT_ENABLED' });
      assert.equal(f.calls.length, 0);
    }
  }
  const f = fixture();
  await assert.rejects(f.dispatcher.dispatch('../other'), { code: 'INVALID_VIDEO_ID' });
  assert.equal(f.calls.length, 0);
});

test('reject floating image, mismatched environment, missing proof/revision', () => {
  const { config } = fixture();
  for (const change of [{ workerImage: 'registry.example.test/worker:latest' },
    { environmentId: `${config.workspaceId}/environments/video-worker/versions/1` },
    { licenseProofRef: '' }, { modelRevision: '' }]) {
    assert.throws(() => createDispatcher({ ...config, ...change }), { code: 'INVALID_DISPATCH_CONFIGURATION' });
  }
});

test('timeout bounded and transport secrets never leak in exceptions', async () => {
  const auth = randomBytes(24).toString('hex');
  const url = new URL('https://reserved.example.test/private');
  url.username = randomBytes(12).toString('hex');
  url.password = auth;
  const f = fixture([], { fetchImpl: async () => { throw new Error(url.href); } });
  await assert.rejects(f.dispatcher.dispatch(f.id), error => {
    assert.equal(error.code, 'ARM_REQUEST_FAILED');
    assert.equal(String(error).includes(auth), false);
    assert.equal(String(error).includes(url.username), false);
    assert.equal(String(error).includes(url.href), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  const hanging = fixture([], { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(hanging.dispatcher.dispatch(hanging.id), { code: 'ARM_TIMEOUT' });
});

test('late identity token after deadline cannot submit a request', async () => {
  let resolveToken;
  const f = fixture([], { timeoutMs: 5, tokenProvider: () => new Promise(resolve => { resolveToken = resolve; }) });
  await assert.rejects(f.dispatcher.dispatch(f.id), { code: 'ARM_TIMEOUT' });
  resolveToken(randomBytes(16).toString('hex'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
});