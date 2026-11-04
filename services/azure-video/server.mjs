import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { VideoJobs } from './jobs.mjs';
import { createAzureStore } from './azure-store.mjs';
import { dispatcherFromEnv } from './dispatcher.mjs';

// Activation is fail-closed until licensing, quota and the deployed worker are verified.
export function createVideoServer({ tokenHash = process.env.VIDEO_API_TOKEN_SHA256,
  jobs, store, enabled = false } = {}) {
  if (!/^[a-f0-9]{64}$/.test(tokenHash || '')) {
    throw new Error('VIDEO_API_TOKEN_SHA256 must be a SHA-256 digest');
  }
  const expected = Buffer.from(tokenHash, 'hex');
  const safeCodes = new Set(['invalid_principal', 'idempotency_key_required', 'unsupported_fields',
    'invalid_prompt', 'unsupported_model', 'invalid_duration', 'duration_budget_exceeded',
    'unsupported_aspect_ratio', 'unsupported_resolution', 'invalid_seed', 'idempotency_conflict',
    'lease_lost', 'generation_not_enabled', 'storage_unavailable', 'queue_unavailable', 'contention',
    'video_not_found']);
  let inflight = 0;
  const server = createServer(async (request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      response.end(JSON.stringify(body));
      request.resume();
    };
    const error = (status, code, message, headers) => send(status, {
      error: { type: 'video_service_error', code, message },
    }, headers);
    let path;
    try {
      path = new URL(request.url, 'http://localhost').pathname;
    } catch {
      error(400, 'invalid_request', 'Invalid request');
      return;
    }
    if (request.method === 'GET' && path === '/healthz') {
      send(200, { status: 'ok', service: 'makinari-video' });
      return;
    }
    const authorization = request.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const actual = createHash('sha256').update(token).digest();
    if (!token || !timingSafeEqual(actual, expected)) {
      error(401, 'invalid_api_key', 'Authentication required', { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    // Support both common base paths without changing existing Makinari routes.
    path = path.replace(/^\/api\/v1(?=\/|$)/, '/v1');
    if (inflight >= 2) { error(429, 'too_many_requests', 'Service concurrency limit reached', { 'Retry-After': '30' }); return; }
    inflight++;
    let released = false;
    const release = () => { if (!released) { inflight--; released = true; } };
    response.once('finish', release);
    response.once('close', release);
    const active = enabled && jobs?.config?.enabled === true && store;
    const project = job => ({ id: job.id, object: 'video', model: job.request.model,
      status: job.status === 'queued' ? 'pending' : job.status,
      created_at: Math.floor(job.created_at / 1000),
      seconds: String(job.request.duration_seconds), duration: job.request.duration_seconds,
      resolution: job.request.resolution, aspect_ratio: job.request.aspect_ratio,
      ...(job.error ? { error: { code: job.error.code, message: 'Video generation failed' } } : {}),
    });
    try {
    if (request.method === 'GET' && path === '/readyz') {
      if (active) {
        send(200, { status: 'ready', generation_enabled: true });
        return;
      }
      send(503, {
        status: 'blocked', generation_enabled: false,
        blockers: ['model_license_not_confirmed', 'gpu_quota_not_approved', 'worker_not_deployed'],
      });
    } else if (request.method === 'GET' && ['/v1/models', '/v1/videos/models'].includes(path)) {
      send(200, { object: 'list', data: active ? [{
        id: 'h3-base', object: 'model', owned_by: 'makinari',
        supported_durations: Array.from({ length: 12 }, (_, i) => i + 4),
        supported_aspect_ratios: ['16:9', '9:16', '1:1'],
        supported_resolutions: ['768p'], supported_frame_images: [],
        architecture: { input_modalities: ['text'], output_modalities: ['video', 'audio'] },
      }] : [] });
    } else if (request.method === 'POST' && path === '/v1/videos') {
      if (!active) {
        error(503, 'generation_not_enabled', 'Video generation is not enabled; no job was created or billed');
        return;
      }
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        error(415, 'unsupported_media_type', 'Use application/json; multipart references are not supported');
        return;
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 32 * 1024) { error(413, 'request_too_large', 'Request exceeds 32 KiB'); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { error(400, 'invalid_json', 'Invalid JSON'); return; }
      const job = await jobs.create('makinari-service', body, request.headers['idempotency-key']);
      send(job.status === 'completed' ? 200 : 202, project(job), { 'Retry-After': '30' });
    } else if (request.method === 'GET' && /^\/v1\/videos\/[^/]+(?:\/content)?$/.test(path)) {
      if (!jobs) { error(404, 'video_not_found', 'Video not found'); return; }
      const id = path.split('/')[3];
      const job = await jobs.get('makinari-service', id);
      if (path.endsWith('/content')) {
        if (job.status !== 'completed') { error(409, 'video_not_ready', 'Video is not completed'); return; }
        const content = await store.getContent(id);
        if (!content) { error(404, 'video_expired', 'Video content is no longer available'); return; }
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment; filename="video.mp4"' });
        response.end(content.body);
      } else send(200, project(job), { 'Retry-After': '30' });
    } else {
      error(404, 'not_found', 'Endpoint not found');
    }
    } catch (caught) {
      if (response.headersSent) { response.destroy(); return; }
      const status = [400, 404, 409, 413, 415].includes(caught?.status) ? caught.status : 503;
      // Codes are internal allowlisted structure, never upstream response bodies.
      const code = safeCodes.has(caught?.code)
        ? caught.code : 'video_service_unavailable';
      error(status, code, 'Video request could not be completed; retry with the same idempotency key');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 100;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const enabled = process.env.VIDEO_GENERATION_ENABLED === 'true'
    && process.env.H3_LICENSE_APPROVED === 'true' && process.env.H3_WORKER_READY === 'true';
  let store, jobs;
  if (enabled) {
    const adapter = createAzureStore({ accountName: process.env.VIDEO_STORAGE_ACCOUNT });
    const dispatcher = dispatcherFromEnv();
    store = { ...adapter, async enqueue(id) {
      await adapter.enqueue(id);
      await dispatcher.dispatch(id);
    } };
    jobs = new VideoJobs({ store, config: { enabled: true, leaseMs: 1_860_000 } });
  }
  const server = createVideoServer({ enabled, store, jobs });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}