import { pathToFileURL } from 'node:url';
import { createAzureStore } from './azure-store.mjs';
import { dispatcherFromEnv } from './dispatcher.mjs';

// CPU-only, finite invocation for an externally configured manual/scheduled job.
// Nothing is scheduled or activated here. Repairs queue publication followed by
// a crashed inline dispatch using the SAME durable video ID (never a retry ID).
// Poison messages remain in video-jobs for operator inspection: there is no
// provisioned dead-letter queue, so never silently delete them. Alert on retained.
// Caller-owned adapters must gate GPU dispatch. CLI additionally gates BEFORE
// constructing adapters. A timeout cannot undo an already accepted ARM request.
export const PUMP_TIMEOUT_MS = 110_000;
const fault = code => Object.assign(new Error(code), { code });
const validId = id => typeof id === 'string' && /^video_[a-f0-9]{64}$/.test(id);

export async function pump({ store, dispatcher, maxMessages = 10, timeoutMs = PUMP_TIMEOUT_MS } = {}) {
  if (!store || typeof store.receive !== 'function' || typeof store.deleteMessage !== 'function' ||
      typeof dispatcher?.dispatch !== 'function' || !Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 10 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PUMP_TIMEOUT_MS) throw fault('INVALID_PUMP_CONFIGURATION');
  const result = { received: 0, dispatched: 0, deleted: 0, retained: 0, status: 'complete' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  async function wait(operation) {
    if (controller.signal.aborted) throw fault('PUMP_TIMEOUT');
    let listener;
    const stopped = new Promise((_, reject) => {
      listener = () => reject(fault('PUMP_TIMEOUT'));
      controller.signal.addEventListener('abort', listener, { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw fault('PUMP_TIMEOUT');
        return operation();
      }), stopped]);
    } finally { controller.signal.removeEventListener('abort', listener); }
  }
  let stage = 'receive';
  try {
    for (let i = 0; i < maxMessages; i++) {
      stage = 'receive';
      const messages = await wait(() => store.receive({ maxMessages: 1, visibilitySeconds: 120 }));
      if (!Array.isArray(messages) || messages.length > 1) throw fault('INVALID_QUEUE_RESPONSE');
      if (!messages.length) break;
      result.received++;
      result.retained++;
      const message = messages[0];
      if (!message || !validId(message.jobId) || typeof message.messageId !== 'string' || !message.messageId ||
          typeof message.popReceipt !== 'string' || !message.popReceipt ||
          !Number.isSafeInteger(message.dequeueCount) || message.dequeueCount < 1) {
        result.status = 'invalid_message';
        break;
      }
      if (message.dequeueCount >= 10) {
        result.status = 'dequeue_limit';
        break;
      }
      stage = 'dispatch';
      const dispatched = await wait(() => dispatcher.dispatch(message.jobId));
      if (dispatched?.id !== message.jobId || (dispatched.submitted !== true && dispatched.existing !== true)) {
        throw fault('DISPATCH_NOT_CONFIRMED');
      }
      result.dispatched++;
      stage = 'delete';
      await wait(() => store.deleteMessage(message.messageId, message.popReceipt));
      result.deleted++;
      result.retained--;
    }
  } catch {
    // Fixed status codes only: never return adapter errors, receipts or job IDs.
    result.status = controller.signal.aborted ? 'timeout' : `${stage}_failed`;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return result;
}

export async function runFromEnv(env = process.env, { storeFactory = createAzureStore, dispatcherFactory = dispatcherFromEnv } = {}) {
  if (env.VIDEO_GENERATION_ENABLED !== 'true' || env.H3_LICENSE_APPROVED !== 'true' || env.H3_WORKER_READY !== 'true') {
    return { received: 0, dispatched: 0, deleted: 0, retained: 0, status: 'disabled' };
  }
  // Dispatcher validates pinned image/environment/revision and license proof.
  const dispatcher = dispatcherFactory(env);
  const store = storeFactory({ accountName: env.VIDEO_STORAGE_ACCOUNT, clientId: env.AZURE_CLIENT_ID,
    identity: 'container-apps', identityEndpoint: env.IDENTITY_ENDPOINT, identityHeader: env.IDENTITY_HEADER,
    maxVisibilitySeconds: 120, timeoutMs: 10_000 });
  return pump({ store, dispatcher });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Hard process deadline also bounds adapters that ignore cancellation and any
  // lingering sockets. Uncertain dispatch/delete must reconcile on redelivery.
  const watchdog = setTimeout(() => {
    console.log(JSON.stringify({ status: 'timeout' }));
    process.exit(1);
  }, 115_000);
  try {
    const result = await runFromEnv();
    console.log(JSON.stringify(result));
    clearTimeout(watchdog);
    process.exit(['complete', 'disabled'].includes(result.status) ? 0 : 1);
  } catch {
    console.log(JSON.stringify({ status: 'configuration_failed' }));
    clearTimeout(watchdog);
    process.exit(1);
  }
}