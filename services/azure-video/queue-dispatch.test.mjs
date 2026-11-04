import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pump, runFromEnv, PUMP_TIMEOUT_MS } from './queue-dispatch.mjs';

const secret = () => randomBytes(32).toString('hex');
const message = (jobId = `video_${secret()}`, dequeueCount = 1) => ({ jobId, dequeueCount,
  messageId: randomUUID(), popReceipt: secret() });
function harness(messages = []) {
  const received = [], dispatched = [], deleted = [], existing = new Set();
  let creates = 0;
  return { received, dispatched, deleted, get creates() { return creates; },
    store: {
      async receive(options) { received.push(options); return messages.length ? [messages.shift()] : []; },
      async deleteMessage(...args) { deleted.push(args); },
    },
    dispatcher: { async dispatch(id) {
      dispatched.push(id);
      const duplicate = existing.has(id);
      if (!duplicate) creates++;
      existing.add(id);
      return { id, submitted: !duplicate, existing: duplicate };
    } },
  };
}

test('empty queue ends without dispatch, receives one with 120s visibility', async () => {
  const h = harness();
  assert.deepEqual(await pump(h), { received: 0, dispatched: 0, deleted: 0, retained: 0, status: 'complete' });
  assert.deepEqual(h.received, [{ maxMessages: 1, visibilitySeconds: 120 }]);
  assert.equal(h.creates, 0);
});

test('duplicate publication dispatches same durable ID and acknowledges each receipt only after success', async () => {
  const first = message(), duplicate = message(first.jobId);
  const h = harness([first, duplicate]);
  const original = h.store.deleteMessage;
  h.store.deleteMessage = async (...args) => {
    assert.equal(h.dispatched.length, h.deleted.length + 1);
    await original(...args);
  };
  assert.deepEqual(await pump(h), { received: 2, dispatched: 2, deleted: 2, retained: 0, status: 'complete' });
  assert.deepEqual(h.dispatched, [first.jobId, first.jobId]);
  assert.equal(h.creates, 1);
  assert.deepEqual(h.deleted, [[first.messageId, first.popReceipt], [duplicate.messageId, duplicate.popReceipt]]);
});

test('hard cap ten receives per invocation and supports smaller bounds', async () => {
  for (const maxMessages of [1, 3, 10]) {
    const h = harness(Array.from({ length: 12 }, () => message()));
    const result = await pump({ ...h, maxMessages });
    assert.equal(result.deleted, maxMessages);
    assert.equal(h.received.length, maxMessages);
  }
  assert.ok(PUMP_TIMEOUT_MS < 120_000);
  for (const maxMessages of [0, 11, -1, 1.1, '10']) {
    await assert.rejects(pump({ ...harness(), maxMessages }), { code: 'INVALID_PUMP_CONFIGURATION' });
  }
  for (const timeoutMs of [0, 120_000, Infinity]) {
    await assert.rejects(pump({ ...harness(), timeoutMs }), { code: 'INVALID_PUMP_CONFIGURATION' });
  }
});

test('dispatch failure/uncertainty retains message and never retries or deletes inline', async () => {
  const item = message();
  const marker = secret();
  const h = harness([item, message()]);
  h.dispatcher.dispatch = async id => { h.dispatched.push(id); throw new Error(marker); };
  const result = await pump(h);
  assert.equal(result.status, 'dispatch_failed');
  assert.equal(result.retained, 1);
  assert.equal(h.deleted.length, 0);
  assert.equal(h.received.length, 1);
  for (const sensitive of [marker, item.jobId, item.popReceipt]) assert.equal(JSON.stringify(result).includes(sensitive), false);
});

test('unconfirmed or mismatched dispatch result is never acknowledged', async () => {
  for (const response of [undefined, {}, { submitted: true }, { id: 'wrong', existing: true }]) {
    const h = harness([message()]);
    h.dispatcher.dispatch = async () => response;
    assert.equal((await pump(h)).status, 'dispatch_failed');
    assert.equal(h.deleted.length, 0);
  }
});

test('delete failure leaves receipt retained; same-ID redelivery reconciles without another create', async () => {
  const first = message();
  const h = harness([first, message(first.jobId)]);
  const original = h.store.deleteMessage;
  h.store.deleteMessage = async () => { throw new Error(secret()); };
  assert.deepEqual(await pump(h), { received: 1, dispatched: 1, deleted: 0, retained: 1, status: 'delete_failed' });
  h.store.deleteMessage = original;
  assert.equal((await pump(h)).deleted, 1);
  assert.equal(h.creates, 1);
});

test('poison messages at dequeue ten remain visible later for operator action, no GPU launch', async () => {
  for (const count of [10, 11, 100]) {
    const h = harness([message(undefined, count)]);
    assert.deepEqual(await pump(h), { received: 1, dispatched: 0, deleted: 0, retained: 1, status: 'dequeue_limit' });
    assert.equal(h.creates, 0);
    assert.equal(h.deleted.length, 0);
  }
  assert.equal((await pump(harness([message(undefined, 9)]))).deleted, 1);
});

test('invalid messages and receive failures do not dispatch or leak provider errors', async () => {
  for (const item of [null, message('../bad'), { ...message(), dequeueCount: 0 }, { ...message(), popReceipt: '' }]) {
    const h = harness([item]);
    assert.equal((await pump(h)).status, 'invalid_message');
    assert.equal(h.creates, 0);
    assert.equal(h.deleted.length, 0);
  }
  const h = harness();
  const marker = secret();
  h.store.receive = async () => { throw new Error(marker); };
  const result = await pump(h);
  assert.equal(result.status, 'receive_failed');
  assert.equal(JSON.stringify(result).includes(marker), false);
});

test('deadline bounds stalled operations; late receive/dispatch cannot cause later side effects', async () => {
  for (const stage of ['receive', 'dispatch', 'delete']) {
    const item = message();
    const h = harness([item]);
    let finish;
    const stalled = () => new Promise(resolve => { finish = resolve; });
    if (stage === 'receive') h.store.receive = stalled;
    if (stage === 'dispatch') h.dispatcher.dispatch = stalled;
    if (stage === 'delete') h.store.deleteMessage = stalled;
    const result = await pump({ ...h, timeoutMs: 10 });
    assert.equal(result.status, 'timeout');
    finish(stage === 'receive' ? [item] : { id: item.jobId, submitted: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.deleted.length, 0);
    if (stage === 'receive') assert.equal(h.dispatched.length, 0);
  }
});

test('CLI gates all three flags before constructing any adapter', async () => {
  const enabled = { VIDEO_GENERATION_ENABLED: 'true', H3_LICENSE_APPROVED: 'true', H3_WORKER_READY: 'true' };
  const forbidden = () => { assert.fail('must not construct disabled adapters'); };
  for (const key of Object.keys(enabled)) {
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      const result = await runFromEnv({ ...enabled, [key]: value }, { storeFactory: forbidden, dispatcherFactory: forbidden });
      assert.equal(result.status, 'disabled');
    }
  }
  const h = harness();
  const env = { ...enabled, VIDEO_STORAGE_ACCOUNT: 'offlineaccount', AZURE_CLIENT_ID: randomUUID(),
    IDENTITY_ENDPOINT: 'http://127.0.0.1:42356/msi/token', IDENTITY_HEADER: secret() };
  assert.equal((await runFromEnv(env, {
    dispatcherFactory: actual => { assert.equal(actual, env); return h.dispatcher; },
    storeFactory: options => {
      assert.equal(options.accountName, env.VIDEO_STORAGE_ACCOUNT);
      assert.equal(options.identityHeader, env.IDENTITY_HEADER);
      assert.equal(options.maxVisibilitySeconds, 120);
      assert.equal(options.identity, 'container-apps');
      return h.store;
    },
  })).status, 'complete');
});

test('CLI is safe when disabled or enabled with invalid configuration, no cloud calls', () => {
  const marker = secret();
  for (const enabled of [false, true]) {
    const result = spawnSync(process.execPath, [new URL('./queue-dispatch.mjs', import.meta.url).pathname], {
      encoding: 'utf8', timeout: 3000,
      env: { VIDEO_GENERATION_ENABLED: String(enabled), H3_LICENSE_APPROVED: 'true', H3_WORKER_READY: 'true',
        VIDEO_AML_WORKSPACE_ID: marker },
    });
    assert.equal(result.status, enabled ? 1 : 0);
    assert.equal(JSON.parse(result.stdout).status, enabled ? 'configuration_failed' : 'disabled');
    assert.equal((result.stdout + result.stderr).includes(marker), false);
  }
});