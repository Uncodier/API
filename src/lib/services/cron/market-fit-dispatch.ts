import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const WORKER_PATHS = {
  marketplace: '/api/marketplace/worker',
  'credit-auto-top-up': '/api/stripe/auto-top-up/worker',
} as const;
type Worker = keyof typeof WORKER_PATHS;
const count = z.number().int().nonnegative();
const marketplaceResult = z.object({ refreshed: count, unavailable: count }).strict();
const billingResult = z.object({
  results: z.array(z.object({
    siteId: z.string().uuid(),
    outcome: z.enum(['succeeded', 'canceled', 'not_eligible', 'in_progress', 'needs_reconciliation',
      'requires_action', 'requires_payment_method', 'requires_confirmation', 'requires_capture', 'processing']),
  })).max(20),
  deferred: count,
}).strict();

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(request.headers.get('authorization') || ''), digest(`Bearer ${secret}`));
}

function workerUrl(worker: Worker): URL {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) throw new Error('Worker origin is not configured');
  const origin = new URL(configured);
  const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(origin.hostname);
  const test = process.env.NODE_ENV === 'test' && origin.hostname.endsWith('.example.test');
  const trusted = origin.hostname === 'app.makinari.com' || origin.hostname.endsWith('.vercel.app');
  if ((!local && !test && !trusted) || (!local && origin.protocol !== 'https:') ||
    (local && !['http:', 'https:'].includes(origin.protocol)) || (!local && origin.port) ||
    origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Invalid worker origin');
  }
  return new URL(WORKER_PATHS[worker], origin);
}

async function readResult(response: Response): Promise<unknown> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new Error('Worker response unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Worker response missing');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        throw new Error('Worker response too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** API owns scheduling. Domain workers remain single-sourced in the commerce app. */
export async function dispatchMarketFitWorker(request: Request, worker: Worker): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const secret = process.env.SERVICE_API_KEY?.trim();
  if (!secret) return Response.json({ error: 'Worker dispatch is not configured' }, { status: 503 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 270_000);
  try {
    const response = await fetch(workerUrl(worker), {
      method: 'POST', headers: { 'x-api-key': secret, accept: 'application/json' },
      cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    const raw = await readResult(response);
    const result = worker === 'marketplace' ? marketplaceResult.parse(raw) : billingResult.parse(raw);
    return Response.json({ worker, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // No automatic retries: the remote worker may already have committed effects.
    return Response.json({ error: 'Worker dispatch failed or its outcome is unknown; no retry was issued' }, { status: 503 });
  } finally { clearTimeout(timeout); }
}