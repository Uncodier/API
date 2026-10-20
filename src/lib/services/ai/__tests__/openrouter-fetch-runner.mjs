// Real SDK bundled in memory: no .env, external services, paid calls or files written.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire, Module } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import url from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const nativeFetch = globalThis.fetch;
const legacyParse = url.parse;
let legacyCalls = 0;
url.parse = () => { legacyCalls++; throw new Error('Legacy URL parsing must not be used'); };
const warnings = [];
process.on('warning', warning => warnings.push(warning.code));
const requests = [];
let mode = 'embedding';
let providerCalls = 0;
let activeStreamingResponse;
let streamedResponseClosed = false;
const server = createServer(async (request, response) => {
  providerCalls++;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({ path: request.url, method: request.method, headers: request.headers, body });
  if (mode === 'hang') return;
  if (mode === 'redirect') {
    response.writeHead(307, { location: 'https://example.invalid/never-follow' });
    response.end(); return;
  }
  if (mode === 'reject') {
    response.writeHead(429, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic rate limit' } })); return;
  }
  if (mode === 'stream' || mode === 'cancel-stream') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] })}\n\n`;
    response.write(event.slice(0, 13));
    response.write(event.slice(13));
    if (mode === 'cancel-stream') {
      activeStreamingResponse = response;
      response.on('close', () => { streamedResponseClosed = true; });
      return;
    }
    response.end('data: [DONE]\n\n'); return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(mode === 'embedding'
    ? { object: 'list', model: 'openai/text-embedding-3-small', data: [{ index: 0, embedding: Array(1536).fill(.1) }],
      usage: { prompt_tokens: 1, total_tokens: 1 } }
    : { id: 'offline', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] }));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const credential = randomBytes(24).toString('hex');
try {
  // Preserve the production client and options; redirect only the test's network I/O.
  globalThis.fetch = (input, init) => {
    const target = new URL(String(input));
    assert.equal(target.origin, 'https://openrouter.ai');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const local = new URL(target.pathname, `http://127.0.0.1:${server.address().port}`);
    return nativeFetch(local, init);
  };
  const output = await build({ entryPoints: [resolve(root, 'src/lib/services/ai/openrouter.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const filename = resolve(root, 'offline-openrouter-transport.cjs');
  const bundled = new Module(filename);
  bundled.filename = filename;
  bundled.require = createRequire(filename);
  bundled._compile(output.outputFiles[0].text, filename);
  const { createOpenRouterClient } = bundled.exports;
  const client = createOpenRouterClient({ apiKey: credential, timeout: 2_000 });
  const embeddingRequest = { input: 'offline catalog query', model: 'openai/text-embedding-3-small',
    dimensions: 1536, encoding_format: 'float' };
  const chatRequest = { model: 'openai/gpt-6.1-sol', messages: [{ role: 'user', content: 'offline chat' }] };

  const embedding = await client.embeddings.create(embeddingRequest);
  assert.equal(embedding.data[0].embedding.length, 1536);
  assert.equal(requests[0].path, '/api/v1/embeddings');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.authorization, `Bearer ${credential}`);
  assert.deepEqual(requests[0].body, embeddingRequest);

  mode = 'chat';
  assert.equal((await client.chat.completions.create(chatRequest)).choices[0].message.content, 'hello');

  mode = 'stream';
  const stream = await client.chat.completions.create({ ...chatRequest, stream: true });
  let text = '';
  for await (const chunk of stream) text += chunk.choices[0].delta.content ?? '';
  assert.equal(text, 'hello');

  mode = 'hang';
  const beforeTimeout = providerCalls;
  await assert.rejects(client.embeddings.create(embeddingRequest, { timeout: 50 }),
    error => error.constructor.name === 'APIConnectionTimeoutError');
  assert.equal(providerCalls, beforeTimeout + 1);

  const controller = new AbortController();
  const beforeAbort = providerCalls;
  const pending = client.embeddings.create(embeddingRequest, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, error => error.constructor.name === 'APIUserAbortError');
  assert.equal(providerCalls, beforeAbort + 1);

  mode = 'reject';
  const beforeRejection = providerCalls;
  await assert.rejects(client.embeddings.create(embeddingRequest), error => error.status === 429);
  assert.equal(providerCalls, beforeRejection + 1);

  mode = 'redirect';
  const beforeRedirect = providerCalls;
  await assert.rejects(client.embeddings.create(embeddingRequest),
    error => error.constructor.name === 'APIConnectionError');
  assert.equal(providerCalls, beforeRedirect + 1);

  mode = 'cancel-stream';
  const cancellable = await client.chat.completions.create({ ...chatRequest, stream: true });
  for await (const chunk of cancellable) { assert.equal(chunk.choices[0].delta.content, 'hello'); break; }
  assert.equal(cancellable.controller.signal.aborted, true);
  for (let attempt = 0; attempt < 50 && !streamedResponseClosed; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(streamedResponseClosed);
  assert.equal(legacyCalls, 0);
  assert.ok(!warnings.includes('DEP0169'));
  console.log('Validated 8 native OpenRouter transport scenarios');
} finally {
  globalThis.fetch = nativeFetch;
  url.parse = legacyParse;
  activeStreamingResponse?.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}