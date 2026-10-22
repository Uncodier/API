// Offline integration harness: execute the installed SDK's actual step handler,
// not a hand-written retry loop. Only the queue/world and image I/O are in-memory.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const sdk = (file) => import(pathToFileURL(resolve('node_modules/@workflow/core/dist', file)).href);
const entries = new Map();
const events = [];
let handler;
let failCompletion = false;
const world = {
  specVersion: 2,
  createQueueHandler(prefix, callback) {
    handler = callback;
    return async () => new Response(null, { status: 204 });
  },
  events: {
    async create(runId, event) {
      const entry = entries.get(event.correlationId);
      if (event.eventType === 'step_completed' && failCompletion) {
        failCompletion = false;
        throw new Error('temporary result persistence failure');
      }
      events.push(event);
      if (event.eventType === 'step_started') {
        entry.attempt++;
        entry.startedAt = new Date();
        entry.status = 'running';
        return { step: entry };
      }
      if (event.eventType === 'step_completed') entry.result = event.eventData.result;
      if (event.eventType === 'step_failed') entry.error = event.eventData.error;
      return {};
    },
  },
  async queue() { return { messageId: randomUUID() }; },
};
// Inject BEFORE importing the handler: avoid initializing any real world/client.
globalThis[Symbol.for('@workflow/world//cache')] = world;
globalThis[Symbol.for('@workflow/world//stubbedCache')] = world;
const { setPortResolverForTesting } = await sdk('runtime/get-port-lazy.js');
setPortResolverForTesting(async () => 3000);
const { registerStepFunction } = await sdk('private.js');
const { dehydrateStepArguments, hydrateStepReturnValue } = await sdk('serialization.js');
await sdk('runtime/step-handler.js');
assert.equal(typeof handler, 'function');

let generations = 0;
let downloads = 0;
let uploads = 0;
let generationFails = false;
let uploadFails = false;
const serviceKey = randomBytes(32).toString('hex');
globalThis.__imageTest = {
  async generateImage(params, options) {
    generations++;
    assert.equal(params.provider, 'azure');
    assert.equal(params.site_id, 'tenant');
    if (options) assert.match(options.operationId, /^workflow-image:step_/);
    if (generationFails) return { success: false, images: [], error: 'uncertain paid outcome' };
    return { success: true, provider: 'azure', images: [{ url: 'https://storage.example.test/generated.png' }], metadata: { model: 'offline-model' } };
  },
  async uploadToCache(hash) {
    uploads++;
    if (uploadFails) {
      uploadFails = false;
      throw new Error('temporary upload failure');
    }
    return { url: 'https://storage.example.test/cache.png', path: `cache/${hash}.png` };
  },
};
globalThis.fetch = async () => {
  downloads++;
  return new Response('offline-image', { headers: { 'content-type': 'image/png' } });
};
process.env.SERVICE_API_KEY = serviceKey;
const mocks = {
  '@/lib/services/image/ImageGenerationService': 'export const ImageGenerationService = globalThis.__imageTest;',
  '@/lib/services/image/promptImageCache': 'export const uploadToCache = globalThis.__imageTest.uploadToCache;',
  '@/lib/database/supabase-client': 'export const supabaseAdmin = { from: () => ({ insert: async () => ({ error: null }) }) };',
  '@/lib/security/safe-remote-url': 'export const assertSafeRemoteUrl = async value => new URL(value);',
};
async function loadBundle(entry, extraMocks = {}) {
  const mocked = { ...mocks, ...extraMocks };
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'offline-image-dependencies', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (mocked[args.path]) return { path: args.path, namespace: 'offline' };
        if (args.path === 'workflow') return { path: pathToFileURL(resolve('node_modules/workflow/dist/index.js')).href, external: true };
      });
      builder.onLoad({ filter: /.*/, namespace: 'offline' }, args => ({ contents: mocked[args.path], loader: 'js' }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const steps = await loadBundle('src/app/api/public/image/prompt/steps.ts');
assert.equal(steps.generateImageStep.maxRetries, 0);
assert.equal(steps.generateAndCacheImageStep.maxRetries, 0);
assert.equal(steps.cacheGeneratedImageStep.maxRetries, 3);
for (const name of ['generateImageStep', 'cacheGeneratedImageStep', 'generateAndCacheImageStep']) {
  registerStepFunction(name, steps[name]);
}

async function dispatch(name, args) {
  const id = `step_${randomUUID()}`;
  const runId = `wrun_${randomUUID()}`;
  const entry = { stepId: id, attempt: 0, status: 'pending', input: await dehydrateStepArguments({ args }, runId) };
  entries.set(id, entry);
  for (let delivery = 1; delivery <= 6; delivery++) {
    try {
      const response = await handler({ workflowName: 'offline-image', workflowRunId: runId, workflowStartedAt: Date.now(), stepId: id },
        { requestId: randomUUID(), messageId: randomUUID(), queueName: `__wkf_step_${name}`, attempt: delivery });
      if (entry.error) throw new Error(entry.error);
      if (entry.result !== undefined) return hydrateStepReturnValue(entry.result, runId);
      assert.ok(response?.timeoutSeconds, 'SDK must explicitly schedule a retry');
    } catch (error) {
      if (entry.error) throw error;
      // Infrastructure failures retry queue delivery, not a fresh paid operation.
      if (delivery === 6) throw error;
    }
  }
  throw new Error('offline scheduler did not terminate');
}
globalThis.__imageDispatch = dispatch;
const workflow = await loadBundle('src/app/api/public/image/prompt/workflow.ts', {
  './steps': `export const generateImageStep = (...args) => globalThis.__imageDispatch('generateImageStep', args);
    export const cacheGeneratedImageStep = (...args) => globalThis.__imageDispatch('cacheGeneratedImageStep', args);`,
});
const input = { prompt: 'cat', siteId: 'tenant', size: '1024x1024', ratio: '1:1', hash: 'stable-cache-hash' };

generationFails = true;
await assert.rejects(workflow.generatePromptImageWorkflow(input), /uncertain paid outcome/);
assert.equal(generations, 1);
assert.equal(downloads, 0);
assert.equal(uploads, 0);
assert.equal(events.filter(event => event.eventType === 'step_retrying').length, 0);

generationFails = false;
uploadFails = true;
events.length = 0;
assert.deepEqual(await workflow.generatePromptImageWorkflow(input), { status: 'completed' });
assert.equal(generations, 2, 'only one new paid generation for the workflow');
assert.equal(downloads, 2);
assert.equal(uploads, 2);
assert.equal(events.filter(event => event.eventType === 'step_retrying').length, 1);
assert.equal(events.filter(event => event.eventType === 'step_retrying')[0].eventData.stepName, 'cacheGeneratedImageStep');

// Lost step-completion persistence must not re-run a successful paid POST either.
failCompletion = true;
await assert.rejects(dispatch('generateImageStep', ['cat', 'tenant', '1024x1024', '1:1']), /exceeded max retries/);
assert.equal(generations, 3);
assert.equal(downloads, 2);

// Legacy combined callers still execute once: an upload failure is terminal.
uploadFails = true;
await assert.rejects(dispatch('generateAndCacheImageStep', ['cat', 'tenant', '1024x1024', '1:1', 'legacy']), /temporary upload failure/);
assert.equal(generations, 4);
assert.equal(uploads, 3);
console.log('offline SDK scheduler: paid failures/completion loss never replay; upload retry never regenerates; legacy maxRetries0');