import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Runtime/model lifecycle belongs to the external GPU supervisor, never this module.
export const LOCAL_RUNTIME = 'http://127.0.0.1:30010';
export const MAX_CONTENT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_TIMEOUT_MS = 3_600_000;
const FINALIZE_MS = 5_000;
const JSON_LIMIT = 64 * 1024;
const validId = id => typeof id === 'string' && /^video_[a-f0-9]{64}$/.test(id);
const fault = code => Object.assign(new Error(code), { code });
const codes = new Set(['inference_failed', 'output_invalid', 'timeout', 'cancelled']);
const safeCode = error => codes.has(error?.code) ? error.code : 'worker_failed';
const validTimeout = n => Number.isSafeInteger(n) && n > 0 && n <= MAX_TIMEOUT_MS;

function deadline(ms, parent) {
  const controller = new AbortController();
  const cancel = () => controller.abort(fault('cancelled'));
  if (parent?.aborted) cancel();
  else parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(fault('timeout')), ms);
  return {
    signal: controller.signal,
    async wait(operation) {
      controller.signal.throwIfAborted();
      let listener;
      const aborted = new Promise((_, reject) => {
        listener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', listener, { once: true });
      });
      try {
        // Factories, not prestarted promises: no new side effects after the deadline.
        return await Promise.race([Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return operation();
        }), aborted]);
      } finally { controller.signal.removeEventListener('abort', listener); }
    },
    close() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', cancel);
      // Close unfinished HTTP bodies too; no upstream cancellation is implied.
      if (!controller.signal.aborted) controller.abort(fault('cancelled'));
    },
  };
}

async function readBounded(response, limit, budget, code) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw fault(code);
  if (!response.body) throw fault(code);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await budget.wait(() => reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw fault(code);
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Do not await cancellation of an uncooperative injected stream.
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, size);
}

async function request(fetchImpl, path, options, budget) {
  const response = await budget.wait(() => fetchImpl(`${LOCAL_RUNTIME}${path}`, {
    ...options, redirect: 'error', signal: budget.signal,
  }));
  if (response.redirected || response.status < 200 || response.status >= 300) throw fault('inference_failed');
  return response;
}

async function json(fetchImpl, path, options, budget) {
  const response = await request(fetchImpl, path, options, budget);
  const bytes = await readBounded(response, JSON_LIMIT, budget, 'inference_failed');
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('inference_failed');
    return value;
  } catch { throw fault('inference_failed'); }
}

function payload(claimed, id) {
  const r = claimed.request;
  if (claimed.id !== id || claimed.status !== 'in_progress' ||
      !r || r.model !== 'h3-base' || r.resolution !== '768p' ||
      typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.length > 10_000 ||
      !Number.isInteger(r.duration_seconds) || r.duration_seconds < 4 || r.duration_seconds > 15 ||
      !Number.isSafeInteger(r.seed) || r.seed < 0 || r.seed > 0xffff_ffff ||
      !['16:9', '9:16', '1:1'].includes(r.aspect_ratio)) throw fault('worker_failed');
  return { task: 't2va', prompt: r.prompt, conditions: [],
    target: { short_edge: 768, aspect_ratio: r.aspect_ratio, duration_seconds: r.duration_seconds },
    seed: r.seed };
}

/** One durable claim, at most one POST. No model download/start, fallback, or retry. */
export async function runVideoJob({ job, store, jobs, owner, fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS, pollIntervalMs = 1_000, signal } = {}) {
  const id = typeof job === 'string' ? job : job?.id;
  if (!validId(id) || typeof owner !== 'string' || !owner.trim() || owner.length > 256 ||
      !validTimeout(timeoutMs) || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10_000 ||
      typeof fetchImpl !== 'function' || typeof store?.uploadContent !== 'function' ||
      ['claim', 'complete', 'fail'].some(method => typeof jobs?.[method] !== 'function')) {
    throw fault('invalid_configuration');
  }
  const budget = deadline(timeoutMs, signal);
  const end = Date.now() + timeoutMs;
  let claimed;
  try {
    claimed = await budget.wait(() => jobs.claim(id, owner));
    if (!claimed) return { id, status: 'unclaimed' };
    // Queue invisibility is NOT a job lease. Refuse an insufficient durable lease.
    if (!Number.isSafeInteger(claimed.lease_expires_at) || claimed.lease_expires_at <= end + FINALIZE_MS) {
      throw fault('worker_failed');
    }
    const body = payload(claimed, id); // Ignore all caller-supplied job data after claim.
    const submitted = await json(fetchImpl, '/v1/videos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, budget);
    // Never follow runtime-provided URLs, paths, or redirects (including content URLs).
    if (typeof submitted.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(submitted.id)) throw fault('inference_failed');
    const path = `/v1/videos/${submitted.id}`;
    for (;;) {
      const state = await json(fetchImpl, path, { method: 'GET' }, budget);
      if (state.id !== undefined && state.id !== submitted.id) throw fault('inference_failed');
      if (state.status === 'completed') break;
      if (!['queued', 'in_progress'].includes(state.status)) throw fault('inference_failed');
      await budget.wait(() => sleep(pollIntervalMs, undefined, { signal: budget.signal }));
    }
    const response = await request(fetchImpl, `${path}/content`, { method: 'GET' }, budget);
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (contentType !== 'video/mp4') throw fault('output_invalid');
    const bytes = await readBounded(response, MAX_CONTENT_BYTES, budget, 'output_invalid');
    // A container signature check only, NOT decoding/playability or quality proof.
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp' ||
        bytes.readUInt32BE(0) < 12 || bytes.readUInt32BE(0) > bytes.length) throw fault('output_invalid');
    const metadata = { content_key: `videos/${id}.mp4`, content_type: 'video/mp4',
      size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    await budget.wait(() => store.uploadContent(id, bytes));
    await budget.wait(() => jobs.complete(id, owner, metadata));
    return { id, status: 'completed', metadata };
  } catch (error) {
    const code = budget.signal.aborted ? safeCode(budget.signal.reason) : safeCode(error);
    // A claim timeout may already have committed. No ownership proof => no POST/fail.
    if (!claimed) return { id, status: 'uncertain', code };
    budget.close();
    const finalize = deadline(FINALIZE_MS);
    try {
      await finalize.wait(() => jobs.fail(id, owner, code));
      return { id, status: 'failed', code };
    } catch { return { id, status: 'uncertain', code }; }
    finally { finalize.close(); }
  } finally { budget.close(); }
}

/** Direct AML job ID, or receive at most one queue message. Never a daemon. */
export async function runOnce({ jobId, store, jobs, owner = randomUUID(),
  timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...options } = {}) {
  if (!validTimeout(timeoutMs) || (jobId !== undefined && !validId(jobId))) throw fault('invalid_configuration');
  let message;
  const queueBudget = deadline(15_000, signal);
  try {
    if (jobId === undefined) {
      const messages = await queueBudget.wait(() => store.receive({ maxMessages: 1,
        visibilitySeconds: Math.ceil((timeoutMs + 60_000) / 1_000) }));
      if (!Array.isArray(messages) || messages.length > 1) throw fault('worker_failed');
      if (!messages.length) return { status: 'idle' };
      [message] = messages;
      jobId = message.jobId;
      if (!validId(jobId)) throw fault('worker_failed');
    }
  } catch { return { status: 'uncertain', code: 'worker_failed' }; }
  finally { queueBudget.close(); }
  const result = await runVideoJob({ ...options, job: { id: jobId }, store, jobs, owner, timeoutMs, signal });
  // unclaimed could mean another worker is active, so never delete it here.
  if (message && ['completed', 'failed'].includes(result.status)) {
    const ackBudget = deadline(15_000, signal);
    try {
      await ackBudget.wait(() => store.deleteMessage(message.messageId, message.popReceipt));
      return { ...result, queueAcknowledged: true };
    } catch { return { ...result, queueAcknowledged: false }; }
    finally { ackBudget.close(); }
  }
  return result;
}

export function workerConfig(env) {
  if (env.H3_LICENSE_APPROVED !== 'true' || env.H3_WORKER_READY !== 'true') throw fault('worker_not_ready');
  const timeoutMs = Number(env.VIDEO_WORKER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const leaseMs = Number(env.VIDEO_JOB_LEASE_MS ?? timeoutMs + 60_000);
  if (!validTimeout(timeoutMs) || !Number.isSafeInteger(leaseMs) || leaseMs < timeoutMs + 60_000 || leaseMs > 86_400_000 ||
      (env.VIDEO_JOB_ID !== undefined && !validId(env.VIDEO_JOB_ID))) throw fault('invalid_configuration');
  return { timeoutMs, leaseMs, jobId: env.VIDEO_JOB_ID };
}

async function main() {
  let hardTimer;
  try {
    const config = workerConfig(process.env); // Gates precede identity/storage access.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGTERM', cancel);
    process.once('SIGINT', cancel);
    // Covers queue, execution, fail/ack, and uncooperative adapters. Supervisor must
    // additionally kill SGLang's process group; aborting HTTP does NOT stop GPU work.
    hardTimer = setTimeout(() => {
      process.stderr.write('video_worker_deadline\n');
      process.exit(1);
    }, config.timeoutMs + 60_000);
    const [{ createAzureStore }, { VideoJobs }] = await Promise.all([
      import('./azure-store.mjs'), import('./jobs.mjs'),
    ]);
    const store = createAzureStore({ accountName: process.env.VIDEO_STORAGE_ACCOUNT,
      clientId: process.env.AZURE_CLIENT_ID, identity: process.env.VIDEO_STORAGE_IDENTITY ?? 'imds',
      maxVisibilitySeconds: Math.ceil((config.timeoutMs + 60_000) / 1_000) });
    const jobs = new VideoJobs({ store, config: { enabled: true, leaseMs: config.leaseMs } });
    const result = await runOnce({ ...config, store, jobs, signal: controller.signal });
    process.stdout.write(JSON.stringify(result) + '\n');
    // Explicit exit releases this one-shot command even if an adapter retained work.
    process.exit(['completed', 'idle', 'unclaimed'].includes(result.status) ? 0 : 1);
  } catch {
    process.stderr.write('video_worker_unavailable\n');
    process.exit(1);
  } finally { clearTimeout(hardTimer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();