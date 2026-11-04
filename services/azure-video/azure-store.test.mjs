import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { AzureStoreError, createAzureStore, createManagedIdentityTokenProvider, MAX_CONTENT_BYTES, MAX_VISIBILITY_SECONDS } from './azure-store.mjs';

const secret = () => randomBytes(32).toString('hex');
const reply = (body = '', status = 200, headers = {}) => new Response(status === 204 ? null : body, { status, headers });
function harness(options = {}, handle = () => reply('{}', 200, { etag: '"v1"' })) {
  const accessToken = secret();
  const identityHeader = secret();
  const clientId = randomUUID();
  let clock = 1_700_000_000_000;
  const calls = [];
  const config = {
    accountName: 'offlineaccount', clientId, identity: 'container-apps',
    identityEndpoint: 'http://127.0.0.1:42356/msi/token', identityHeader,
    now: () => clock,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, ...init });
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      if (url.pathname.endsWith('/token')) {
        return reply(JSON.stringify({ access_token: accessToken, expires_on: String(clock / 1000 + 3600), token_type: 'Bearer' }));
      }
      assert.equal(init.headers.Authorization, `Bearer ${accessToken}`);
      assert.equal(init.headers['x-ms-version'], '2023-11-03');
      assert.equal(init.headers['X-IDENTITY-HEADER'], undefined);
      return handle(url, init);
    },
    ...options,
  };
  return { store: createAzureStore(config), config, calls, accessToken, identityHeader, clientId,
    advance: milliseconds => { clock += milliseconds; } };
}
const rejectsCode = (operation, code, status) => assert.rejects(operation, error => {
  assert.ok(error instanceof AzureStoreError);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
});

test('exported token providers isolate ARM/storage audiences and cache with expiry skew', async () => {
  const h = harness();
  const armToken = secret();
  const storageToken = secret();
  const calls = [];
  const config = { ...h.config, fetchImpl: async (input, init) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-IDENTITY-HEADER'], h.identityHeader);
    assert.equal(url.searchParams.get('client_id'), h.clientId);
    return reply(JSON.stringify({ access_token: url.searchParams.get('resource') === 'https://management.azure.com/' ? armToken : storageToken,
      expires_on: (h.config.now() + 3600_000) / 1000 }));
  } };
  const arm = createManagedIdentityTokenProvider({ ...config, resource: 'https://management.azure.com/' });
  const storage = createManagedIdentityTokenProvider({ ...config, resource: 'https://storage.azure.com/' });
  assert.deepEqual(await Promise.all([arm(), arm(), storage(), storage()]), [armToken, armToken, storageToken, storageToken]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(url => url.searchParams.get('resource')).sort(), ['https://management.azure.com/', 'https://storage.azure.com/']);
  h.advance(3540_000);
  assert.equal(await arm(), armToken);
  assert.equal(calls.length, 3);
});

test('exported provider rejects every non-allowlisted audience before fetching', () => {
  const h = harness();
  const authenticated = new URL('https://example.invalid/');
  const username = secret();
  const password = secret();
  authenticated.username = username;
  authenticated.password = password;
  for (const resource of ['', null, 'https://management.azure.com', 'http://management.azure.com/',
    'https://management.azure.com/extra', 'https://management.azure.com/?x=y',
    'https://management.azure.com.example.invalid/', authenticated.href, new URL('https://storage.azure.com/')]) {
    assert.throws(() => createManagedIdentityTokenProvider({ ...h.config, resource }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      for (const sensitive of [username, password, h.identityHeader]) assert.equal(inspect(error).includes(sensitive), false);
      return true;
    });
  }
  assert.equal(h.calls.length, 0);
});

test('exported ARM provider supports explicit IMDS and sanitizes failures/timeouts', async () => {
  const h = harness({ identity: 'imds' });
  assert.equal(await createManagedIdentityTokenProvider({ ...h.config, resource: 'https://management.azure.com/' })(), h.accessToken);
  assert.equal(h.calls[0].url.origin, 'http://169.254.169.254');
  assert.deepEqual(h.calls[0].headers, { Metadata: 'true' });
  assert.equal(h.calls[0].url.searchParams.get('resource'), 'https://management.azure.com/');
  const marker = secret();
  const failing = createManagedIdentityTokenProvider({ ...h.config, fetchImpl: async () => { throw new Error(marker); } });
  await assert.rejects(failing(), error => {
    assert.equal(error.code, 'REQUEST_FAILED');
    assert.equal(inspect(error).includes(marker), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  const stalled = createManagedIdentityTokenProvider({ ...h.config, timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) });
  await rejectsCode(stalled(), 'TIMEOUT');
});

test('Container Apps client_id, storage audience, caching and refresh skew', async () => {
  const h = harness();
  await Promise.all([h.store.get('one'), h.store.get('two'), h.store.get('three')]);
  assert.equal(h.calls.length, 4);
  const auth = h.calls[0];
  assert.equal(auth.url.origin, 'http://127.0.0.1:42356');
  assert.equal(auth.url.searchParams.get('api-version'), '2019-08-01');
  assert.equal(auth.url.searchParams.get('client_id'), h.clientId);
  assert.equal(auth.url.searchParams.get('resource'), 'https://storage.azure.com/');
  assert.equal(auth.headers['X-IDENTITY-HEADER'], h.identityHeader);
  assert.equal(auth.headers.Authorization, undefined);
  h.advance(3539_000);
  await h.store.get('four');
  assert.equal(h.calls.filter(c => c.url.pathname === '/msi/token').length, 1);
  h.advance(1000);
  await Promise.all([h.store.get('five'), h.store.get('six')]);
  assert.equal(h.calls.filter(c => c.url.pathname === '/msi/token').length, 2);
});

test('explicit IMDS uses only fixed link-local endpoint, metadata and client_id', async () => {
  const h = harness({ identity: 'imds', identityEndpoint: 'https://example.invalid/ignored' });
  await h.store.get('job');
  const auth = h.calls[0];
  assert.equal(auth.url.origin, 'http://169.254.169.254');
  assert.equal(auth.url.pathname, '/metadata/identity/oauth2/token');
  assert.equal(auth.url.searchParams.get('api-version'), '2018-02-01');
  assert.equal(auth.url.searchParams.get('client_id'), h.clientId);
  assert.deepEqual(auth.headers, { Metadata: 'true' });
});

test('configuration fails closed for invalid accounts, identity and endpoints', () => {
  const { config } = harness();
  const credentialURL = new URL('http://example.invalid/msi/token');
  credentialURL.username = secret();
  credentialURL.password = secret();
  for (const accountName of ['', 'aa', 'a'.repeat(25), 'UPPER', 'a-b', 'a.b', 'a/b', 'a?b', 'a@b', 'a%2fb']) {
    assert.throws(() => createAzureStore({ ...config, accountName }), { code: 'INVALID_ARGUMENT' });
  }
  for (const identityEndpoint of [undefined, '', 'http://example.invalid/msi/token', credentialURL.href,
    'http://169.254.169.254/msi/token', 'https://127.0.0.1/msi/token',
    'http://127.0.0.1/not-token', 'http://127.0.0.1/msi/token?x=y', 'http://127.0.0.1/msi/token#x']) {
    assert.throws(() => createAzureStore({ ...config, identityEndpoint: identityEndpoint ?? '' }), { code: 'INVALID_ARGUMENT' });
  }
  for (const patch of [{ clientId: '' }, { clientId: 'https://example.invalid' }, { identity: 'auto' },
    { identityHeader: '' }, { identityHeader: `${secret()}\r\nInjected: yes` }, { timeoutMs: 0 },
    { timeoutMs: Infinity }, { maxVisibilitySeconds: 0 }, { maxVisibilitySeconds: MAX_VISIBILITY_SECONDS + 1 }]) {
    assert.throws(() => createAzureStore({ ...config, ...patch }), { code: 'INVALID_ARGUMENT' });
  }
});

test('blob JSON get/put, missing objects, exact trusted paths and CAS headers', async () => {
  const h = harness({}, (url, init) => {
    assert.equal(url.origin, 'https://offlineaccount.blob.core.windows.net');
    if (url.pathname.endsWith('/missing')) return reply('', 404);
    if (init.method === 'GET') return reply('{"state":"queued"}', 200, { etag: '"read"' });
    assert.equal(init.body, '{"state":"done"}');
    assert.equal(init.headers['x-ms-blob-type'], 'BlockBlob');
    assert.equal(init.headers['Content-Type'], 'application/json');
    return reply('', 201, { etag: '"write"' });
  });
  assert.deepEqual(await h.store.get('tenant/job.json'), { value: { state: 'queued' }, etag: '"read"' });
  assert.equal(h.calls.at(-1).url.pathname, '/jobs/tenant/job.json');
  assert.equal(await h.store.get('missing'), null);
  for (const condition of [{}, { ifNoneMatch: true }, { ifNoneMatch: '*' }, { etag: '"old"' }]) {
    assert.deepEqual(await h.store.put('job', { state: 'done' }, condition), { etag: '"write"' });
    const headers = h.calls.at(-1).headers;
    assert.equal(headers['If-None-Match'], condition.ifNoneMatch ? '*' : undefined);
    assert.equal(headers['If-Match'], condition.etag);
  }
});

test('409 and 412 are typed CAS failures, never retried', async () => {
  for (const status of [409, 412]) {
    const h = harness({}, () => reply(secret(), status));
    await rejectsCode(h.store.put('job', {}, { ifNoneMatch: true }), 'CAS_CONFLICT', status);
    assert.equal(h.calls.length, 2);
  }
});

test('invalid paths, IDs, conditions and JSON fail before any fetch', async () => {
  const h = harness();
  const bad = ['', '.', '..', '../x', '/x', 'x/', 'x//y', 'x/../y', 'x/./y',
    'x%2fy', 'x?y', 'x#y', 'x\\y', 'https://example.invalid/x', 'a\n', 'é', 'a'.repeat(129)];
  for (const key of bad) {
    await rejectsCode(h.store.get(key), 'INVALID_ARGUMENT');
    await rejectsCode(h.store.put(key, {}), 'INVALID_ARGUMENT');
    await rejectsCode(h.store.getContent(key), 'INVALID_ARGUMENT');
    await rejectsCode(h.store.uploadContent(key, Buffer.alloc(0)), 'INVALID_ARGUMENT');
    await rejectsCode(h.store.enqueue(key), 'INVALID_ARGUMENT');
    await rejectsCode(h.store.deleteMessage(key, secret()), 'INVALID_ARGUMENT');
  }
  await rejectsCode(h.store.getContent('a/b'), 'INVALID_ARGUMENT');
  const circular = {}; circular.self = circular;
  for (const value of [undefined, 1n, circular, 'a'.repeat(1024 * 1024)]) {
    await rejectsCode(h.store.put('job', value), 'INVALID_ARGUMENT');
  }
  for (const options of [{ ifNoneMatch: false }, { ifNoneMatch: 'bad' }, { etag: '' },
    { etag: 'bad\r\nheader' }, { ifNoneMatch: true, etag: '"old"' }]) {
    await rejectsCode(h.store.put('job', {}, options), 'INVALID_ARGUMENT');
  }
  await rejectsCode(h.store.deleteMessage('msg', 'bad\nreceipt'), 'INVALID_ARGUMENT');
  assert.equal(h.calls.length, 0);
});

function queueXML({ messageId = randomUUID(), receipt = secret(), jobId = 'job_123', text,
  count = '1' } = {}) {
  return `<QueueMessagesList><QueueMessage><MessageId>${messageId}</MessageId><InsertionTime>date</InsertionTime><ExpirationTime>date</ExpirationTime><PopReceipt>${receipt}</PopReceipt><TimeNextVisible>date</TimeNextVisible><DequeueCount>${count}</DequeueCount><MessageText>${text ?? Buffer.from(jobId).toString('base64')}</MessageText></QueueMessage></QueueMessagesList>`;
}

test('queue base64 XML enqueue, receive and encoded receipt deletion', async () => {
  const messageId = randomUUID();
  const receipt = `${secret()}+/=&`;
  const h = harness({}, (url, init) => {
    assert.equal(url.origin, 'https://offlineaccount.queue.core.windows.net');
    if (init.method === 'POST') {
      assert.equal(url.pathname, '/video-jobs/messages');
      assert.equal(init.headers['Content-Type'], 'application/xml; charset=utf-8');
      assert.equal(init.body, `<QueueMessage><MessageText>${Buffer.from('job_123').toString('base64')}</MessageText></QueueMessage>`);
      return reply('', 201);
    }
    if (init.method === 'DELETE') {
      assert.equal(url.pathname, `/video-jobs/messages/${messageId}`);
      assert.equal(url.searchParams.get('popreceipt'), receipt);
      assert.equal([...url.searchParams].length, 1);
      return reply('', 204);
    }
    assert.equal(url.searchParams.get('visibilitytimeout'), '300');
    assert.equal(url.searchParams.get('numofmessages'), '2');
    return reply(queueXML({ messageId, receipt: receipt.replace('&', '&amp;') }));
  });
  await h.store.enqueue('job_123');
  const messages = await h.store.receive({ visibilitySeconds: 300, maxMessages: 2 });
  assert.deepEqual(messages, [{ messageId, popReceipt: receipt, jobId: 'job_123', dequeueCount: 1 }]);
  await h.store.deleteMessage(messages[0].messageId, messages[0].popReceipt);
});

test('queue visibility/maxMessages bounds and empty queue formats', async () => {
  const h = harness({ maxVisibilitySeconds: 10 }, () => reply('<QueueMessagesList/>'));
  assert.deepEqual(await h.store.receive(), []);
  assert.equal(h.calls.at(-1).url.searchParams.get('visibilitytimeout'), '10');
  const before = h.calls.length;
  for (const visibilitySeconds of [0, -1, 11, 1.1, Infinity, '1', MAX_VISIBILITY_SECONDS + 1]) {
    await rejectsCode(h.store.receive({ visibilitySeconds }), 'INVALID_ARGUMENT');
  }
  for (const maxMessages of [0, 33, -1, 1.1, '2']) {
    await rejectsCode(h.store.receive({ maxMessages }), 'INVALID_ARGUMENT');
  }
  assert.equal(h.calls.length, before);
  const maximum = harness({ maxVisibilitySeconds: MAX_VISIBILITY_SECONDS }, () => reply('<?xml version="1.0" encoding="utf-8"?><QueueMessagesList></QueueMessagesList>'));
  assert.deepEqual(await maximum.store.receive({ visibilitySeconds: MAX_VISIBILITY_SECONDS, maxMessages: 32 }), []);
});

test('queue rejects malformed XML, entities, duplicate fields, bad IDs and base64', async () => {
  for (const xml of ['not XML', '<QueueMessagesList><QueueMessage/></QueueMessagesList>',
    '<!DOCTYPE x SYSTEM "https://example.invalid/evil">' + queueXML(),
    queueXML({ receipt: '&external;' }), queueXML({ text: '!!!!' }), queueXML({ text: 'Zh==' }),
    queueXML({ jobId: '../escape' }), queueXML({ messageId: '../escape' }),
    queueXML({ count: '0' }), queueXML({ count: '9007199254740992' }),
    queueXML().replace('</QueueMessage>', '<MessageId>duplicate</MessageId></QueueMessage>'),
    queueXML().replace('</QueueMessage>', '</QueueMessage><unexpected/>'),
    queueXML({ receipt: '&#x110000;' })]) {
    await rejectsCode(harness({}, () => reply(xml)).store.receive(), 'INVALID_RESPONSE');
  }
});

test('video uploads and downloads have fixed paths, binary content and 100 MiB limit', async () => {
  const bytes = randomBytes(256);
  const h = harness({}, (url, init) => {
    assert.equal(url.origin, 'https://offlineaccount.blob.core.windows.net');
    if (url.pathname === '/videos/missing.mp4') return reply('', 404);
    assert.equal(url.pathname, '/videos/video_1.mp4');
    if (init.method === 'PUT') {
      assert.equal(init.headers['Content-Type'], 'video/mp4');
      assert.equal(init.headers['x-ms-blob-type'], 'BlockBlob');
      return reply('', 201, { etag: '"video"' });
    }
    return reply(bytes, 200, { 'content-type': 'video/mp4' });
  });
  assert.deepEqual(await h.store.uploadContent('video_1', bytes), { etag: '"video"' });
  assert.deepEqual(h.calls.at(-1).body, bytes);
  assert.deepEqual(await h.store.getContent('video_1'), { body: bytes, contentType: 'video/mp4' });
  assert.equal(await h.store.getContent('missing'), null);
  const big = new Uint8Array(MAX_CONTENT_BYTES + 1);
  await h.store.uploadContent('video_1', big.subarray(0, MAX_CONTENT_BYTES));
  const before = h.calls.length;
  await rejectsCode(h.store.uploadContent('video_1', big), 'INVALID_ARGUMENT');
  await rejectsCode(h.store.uploadContent('video_1', 'text'), 'INVALID_ARGUMENT');
  assert.equal(h.calls.length, before);
});

test('malformed JSON, missing etags and oversized responses are sanitized', async () => {
  await rejectsCode(harness({}, () => reply(secret(), 200, { etag: '"v"' })).store.get('job'), 'INVALID_RESPONSE');
  await rejectsCode(harness({}, () => reply('{}')).store.get('job'), 'INVALID_RESPONSE');
  await rejectsCode(harness({}, () => reply('', 201)).store.put('job', {}), 'INVALID_RESPONSE');
  await rejectsCode(harness({}, () => reply('x'.repeat(1024 * 1024 + 1))).store.get('job'), 'RESPONSE_TOO_LARGE');
  const chunk = new Uint8Array(1024 * 1024);
  let count = 0;
  const h = harness({}, () => new Response(new ReadableStream({ pull(controller) {
    if (count++ < 101) controller.enqueue(chunk); else controller.close();
  } })));
  await rejectsCode(h.store.getContent('video'), 'RESPONSE_TOO_LARGE');
  assert.equal(h.calls.at(-1).signal.aborted, true);
});

test('invalid/expired identity responses are not cached and failures never fall back to IMDS', async () => {
  const { config } = harness();
  for (const body of ['bad json', 'null', '{}', JSON.stringify({ access_token: secret(), expires_on: 1 }),
    JSON.stringify({ access_token: secret(), expires_on: 'tomorrow' }),
    JSON.stringify({ access_token: `${secret()}\n`, expires_on: 2_000_000_000 }),
    ...['Basic', null, {}, 123].map(token_type => JSON.stringify({ access_token: secret(), expires_on: 2_000_000_000, token_type }))]) {
    const calls = [];
    const store = createAzureStore({ ...config, fetchImpl: async url => { calls.push(url); return reply(body); } });
    await rejectsCode(store.get('job'), 'INVALID_TOKEN');
    await rejectsCode(store.get('job'), 'INVALID_TOKEN');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => new URL(url).hostname === '127.0.0.1'));
  }
});

test('response and transport errors never expose credentials, authenticated URLs or causes', async () => {
  const values = Array.from({ length: 5 }, secret);
  const url = new URL('https://example.invalid/private');
  url.username = values[0]; url.password = values[1]; url.searchParams.set('sig', values[2]);
  const sensitive = `${url.href} Authorization: Bearer ${values[3]} X-IDENTITY-HEADER: ${values[4]}`;
  for (const mode of ['http', 'transport', 'redirect', 'identity']) {
    const h = harness({}, () => {
      if (mode === 'transport') throw new Error(sensitive);
      return reply(sensitive, mode === 'redirect' ? 302 : 503, { location: url.href });
    });
    const store = mode === 'identity' ? createAzureStore({ ...h.config, fetchImpl: async () => { throw new Error(sensitive); } }) : h.store;
    await assert.rejects(store.get('job'), error => {
      assert.ok(error instanceof AzureStoreError);
      const rendered = inspect(error) + JSON.stringify(error);
      for (const value of [...values, h.accessToken, h.identityHeader]) assert.equal(rendered.includes(value), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    if (mode !== 'identity') assert.equal(h.calls.length, 2);
  }
});

test('timeouts cover identity fetch, storage fetch and stalled response bodies', async () => {
  for (const stage of ['identity', 'storage', 'body']) {
    const h = harness({ timeoutMs: 15 });
    let signal;
    const store = createAzureStore({ ...h.config, fetchImpl: async (url, init) => {
      const isIdentity = new URL(url).pathname === '/msi/token';
      if (stage !== 'identity' && isIdentity) return h.config.fetchImpl(url, init);
      signal = init.signal;
      if (stage === 'body') return new Response(new ReadableStream({ start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error(secret())), { once: true });
      } }));
      return new Promise(() => {}); // Even a fetch that ignores AbortSignal is bounded.
    } });
    await rejectsCode(store.get('job'), 'TIMEOUT');
    assert.equal(signal.aborted, true);
  }
});

test('failed token requests clear single-flight state, allowing subsequent recovery', async () => {
  const h = harness();
  let attempts = 0;
  const store = createAzureStore({ ...h.config, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/msi/token' && attempts++ === 0) return reply(secret(), 503);
    return h.config.fetchImpl(url, init);
  } });
  await Promise.all([rejectsCode(store.get('one'), 'HTTP_ERROR', 503), rejectsCode(store.get('two'), 'HTTP_ERROR', 503)]);
  assert.equal(attempts, 1);
  assert.deepEqual(await store.get('three'), { value: {}, etag: '"v1"' });
  assert.equal(attempts, 2);
});

test('identity redirects are rejected without a second fetch or secret disclosure', async () => {
  const h = harness();
  let attempts = 0;
  const target = new URL('https://example.invalid/token');
  const marker = secret();
  target.searchParams.set('sig', marker);
  const store = createAzureStore({ ...h.config, fetchImpl: async (_, init) => {
    attempts++;
    assert.equal(init.redirect, 'error');
    return reply(marker, 307, { location: target.href });
  } });
  await assert.rejects(store.get('job'), error => {
    assert.equal(error.code, 'REDIRECT_REJECTED');
    for (const value of [marker, h.identityHeader, h.accessToken]) assert.equal(inspect(error).includes(value), false);
    return true;
  });
  assert.equal(attempts, 1);
});

test('queue parses multiple messages and rejects a server batch over the requested maximum', async () => {
  const first = { messageId: randomUUID(), jobId: 'first', receipt: secret() };
  const second = { messageId: randomUUID(), jobId: 'second', receipt: secret() };
  const xml = queueXML(first).replace('</QueueMessagesList>', '') + queueXML(second).replace('<QueueMessagesList>', '');
  const h = harness({}, () => reply(xml));
  assert.deepEqual((await h.store.receive({ maxMessages: 2 })).map(item => item.jobId), ['first', 'second']);
  await rejectsCode(h.store.receive(), 'INVALID_RESPONSE');
});