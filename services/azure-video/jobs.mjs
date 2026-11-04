import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own = (value, key) => Object.hasOwn(value, key);
const plain = (value) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validId = (id) => typeof id === 'string' && /^video_[a-f0-9]{64}$/.test(id);
const conflict = (error) => [409, 412].includes(error?.status ?? error?.statusCode);
const RETRIES = 12;
const FAILURE_CODES = new Set(['inference_failed', 'worker_failed', 'output_invalid', 'timeout', 'cancelled']);

function error(status, code) {
  // Never propagate adapter errors, user input, URLs, or credentials into errors.
  return Object.assign(new Error(code), { status, code });
}

function identity(value, code) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw error(400, code);
  return value;
}

function normalize(input, maxDuration) {
  const fields = new Set(['prompt', 'model', 'seconds', 'duration', 'duration_seconds', 'aspect_ratio', 'resolution', 'seed']);
  if (!plain(input) || Reflect.ownKeys(input).some((key) => !fields.has(key))) {
    throw error(400, 'unsupported_fields');
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 10_000) {
    throw error(400, 'invalid_prompt');
  }
  if (own(input, 'model') && input.model !== 'h3-base') throw error(400, 'unsupported_model');
  const durations = ['seconds', 'duration', 'duration_seconds'].filter((key) => own(input, key)).map((key) => {
    const value = input[key];
    // JSON numbers and canonical integer strings; no coercion of null/booleans/arrays.
    if (typeof value !== 'number' && !(typeof value === 'string' && /^(?:[4-9]|1[0-5])$/.test(value))) {
      throw error(400, 'invalid_duration');
    }
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) throw error(400, 'invalid_duration');
    return seconds;
  });
  if (!durations.length || durations.some((seconds) => seconds !== durations[0])) throw error(400, 'invalid_duration');
  if (durations[0] > maxDuration) throw error(400, 'duration_budget_exceeded');
  const aspect = own(input, 'aspect_ratio') ? input.aspect_ratio : '16:9';
  if (!['16:9', '9:16', '1:1'].includes(aspect)) throw error(400, 'unsupported_aspect_ratio');
  if (own(input, 'resolution') && input.resolution !== '768p') throw error(400, 'unsupported_resolution');
  const seed = own(input, 'seed') ? input.seed : 0;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw error(400, 'invalid_seed');
  return { prompt: input.prompt.trim(), model: 'h3-base', duration_seconds: durations[0], aspect_ratio: aspect, resolution: '768p', seed };
}

function publicJob(job) {
  const result = {
    id: job.id, status: job.status, request: job.request,
    created_at: job.created_at, updated_at: job.updated_at, attempts: job.attempts,
  };
  if (job.result) result.result = job.result;
  if (job.error) result.error = { code: job.error };
  return structuredClone(result);
}

/**
 * Durable, single-attempt state machine; does not perform or simulate inference.
 * store.get(key) -> {value, etag}|null; store.put(key,value,{ifNoneMatch:true}|{etag})
 * -> {etag}; conflicts must throw status/statusCode 409 or 412. enqueue(id) must
 * durably accept a message before resolving. All writers must honor CAS.
 * Keep job/idempotency records for the entire promised deduplication period;
 * deleting a record removes its protection against repeated inference. A caller
 * must retry an uncertain create with the same key, not allocate a new key.
 * Pending queue publications recover on duplicate create; a background sweeper
 * is outside this minimal get/put/enqueue interface. No timer/GPU is started here.
 * Queue deadlines are durable and enforced lazily on get/create/claim; without
 * another call, a stale record is not rewritten by a background timer.
 * clock() returns epoch milliseconds. Worker owner tokens must be unique per
 * execution. Only a non-null claim authorizes inference, never an ordinary get.
 * maxDurationSeconds bounds requested work, NOT wall-clock cost/monthly spend or
 * global concurrency. A real worker must enforce its own timeout and GPU limit.
 */
export class VideoJobs {
  constructor({ store, clock = Date.now, config = {} } = {}) {
    if (!store || ['get', 'put', 'enqueue'].some((method) => typeof store[method] !== 'function') || typeof clock !== 'function') {
      throw error(500, 'invalid_configuration');
    }
    const { enabled = false, maxDurationSeconds = 15, leaseMs = 300_000, maxAttempts = 1, queueTimeoutMs = 3_600_000 } = config;
    if (typeof enabled !== 'boolean' || !Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 4 || maxDurationSeconds > 15 ||
        !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000 || maxAttempts !== 1 ||
        !Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1 || queueTimeoutMs > 86_400_000) {
      throw error(500, 'invalid_configuration');
    }
    this.store = store;
    this.clock = clock;
    this.config = Object.freeze({ enabled, maxDurationSeconds, leaseMs, maxAttempts, queueTimeoutMs });
  }

  _now() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + Math.max(this.config.leaseMs, this.config.queueTimeoutMs))) throw error(500, 'invalid_clock');
    return now;
  }

  async _read(id) {
    try { return await this.store.get(`jobs/${id}`); }
    catch { throw error(503, 'storage_unavailable'); }
  }

  async _write(job, options) {
    try { await this.store.put(`jobs/${job.id}`, job, options); return true; }
    catch (cause) {
      if (conflict(cause)) return false;
      throw error(503, 'storage_unavailable');
    }
  }

  async create(principal, input, idempotencyKey) {
    if (!this.config.enabled) throw error(503, 'generation_not_enabled');
    const scope = digest(identity(principal, 'invalid_principal'));
    const key = identity(idempotencyKey, 'idempotency_key_required');
    const request = normalize(input, this.config.maxDurationSeconds);
    const id = `video_${digest(['video-jobs-v1', scope, key])}`;
    const requestHash = digest(request);
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const current = await this._read(id);
      if (current) {
        if (current.value.principal_hash !== scope || current.value.request_hash !== requestHash) throw error(409, 'idempotency_conflict');
        return this._publish(id);
      }
      const now = this._now();
      const job = { id, principal_hash: scope, request_hash: requestHash, request, status: 'queued',
        created_at: now, updated_at: now, attempts: 0, queue: 'pending', queue_expires_at: now + this.config.queueTimeoutMs };
      // A timed-out committed write is recovered by retrying this SAME ID/key.
      if (await this._write(job, { ifNoneMatch: true })) return this._publish(id);
    }
    throw error(503, 'contention');
  }

  async _publish(id) {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const current = await this._read(id);
      if (!current) throw error(503, 'storage_unavailable');
      if (await this._expire(current, this._now())) continue;
      const job = current.value;
      if (job.status !== 'queued' || job.queue === 'published') return publicJob(job);
      try { await this.store.enqueue(id); }
      catch { throw error(503, 'queue_unavailable'); }
      // enqueue and marker are not atomic: duplicate delivery is expected and
      // harmless because only one worker can win queued -> in_progress CAS.
      await this._write({ ...job, queue: 'published' }, { etag: current.etag });
    }
    throw error(503, 'contention');
  }

  async _expire(current, now) {
    const job = current.value;
    const queuedExpired = job.status === 'queued' &&
      (job.queue_expires_at ?? job.created_at + this.config.queueTimeoutMs) <= now;
    const executionExpired = job.status === 'in_progress' && job.lease_expires_at <= now;
    if (!queuedExpired && !executionExpired) return false;
    const failed = { ...job, status: 'failed', error: queuedExpired ? 'queue_timeout' : 'execution_ambiguous', updated_at: now };
    delete failed.owner_hash;
    delete failed.lease_expires_at;
    // A lease cannot prove GPU work stopped. Never reclaim or retry inference.
    await this._write(failed, { etag: current.etag });
    return true;
  }

  async get(principal, id) {
    const scope = digest(identity(principal, 'invalid_principal'));
    if (!validId(id)) throw error(404, 'video_not_found');
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const current = await this._read(id);
      if (!current || current.value.principal_hash !== scope) throw error(404, 'video_not_found');
      if (await this._expire(current, this._now())) continue;
      return publicJob(current.value);
    }
    throw error(503, 'contention');
  }

  async claim(id, owner) {
    if (!this.config.enabled) throw error(503, 'generation_not_enabled');
    const ownerHash = digest(identity(owner, 'invalid_owner'));
    if (!validId(id)) return null;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const current = await this._read(id);
      if (!current) return null;
      const now = this._now();
      if (await this._expire(current, now)) continue;
      const job = current.value;
      if (job.status !== 'queued') return null;
      if (job.attempts !== 0) {
        if (await this._write({ ...job, status: 'failed', error: 'attempt_limit', updated_at: now }, { etag: current.etag })) return null;
        continue;
      }
      const claimed = { ...job, status: 'in_progress', queue: 'published', attempts: 1,
        owner_hash: ownerHash, lease_expires_at: now + this.config.leaseMs, updated_at: now };
      if (await this._write(claimed, { etag: current.etag })) {
        // Worker-only deadline; normal create/get projections omit lease data.
        return { ...publicJob(claimed), lease_expires_at: claimed.lease_expires_at };
      }
    }
    throw error(503, 'contention');
  }

  async complete(id, owner, metadata) {
    // No remote URLs or arbitrary worker-provided strings are persisted. This
    // records a trusted worker's artifact claim, NOT proof it exists/is playable.
    if (!validId(id) || !plain(metadata) || Reflect.ownKeys(metadata).some((key) =>
      !['content_key', 'content_type', 'size_bytes', 'sha256'].includes(key)) ||
      metadata.content_key !== `videos/${id}.mp4` || metadata.content_type !== 'video/mp4' ||
      !Number.isSafeInteger(metadata.size_bytes) || metadata.size_bytes <= 0 ||
      typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw error(400, 'invalid_metadata');
    return this._finish(id, owner, { status: 'completed', result: structuredClone(metadata) });
  }

  async fail(id, owner, code) {
    return this._finish(id, owner, { status: 'failed', error: FAILURE_CODES.has(code) ? code : 'worker_failed' });
  }

  async _finish(id, owner, terminal) {
    const ownerHash = digest(identity(owner, 'invalid_owner'));
    if (!validId(id)) throw error(404, 'video_not_found');
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const current = await this._read(id);
      if (!current) throw error(404, 'video_not_found');
      const now = this._now();
      if (await this._expire(current, now)) continue;
      const job = current.value;
      if (job.status !== 'in_progress' || job.owner_hash !== ownerHash) throw error(409, 'lease_lost');
      const finished = { ...job, ...terminal, updated_at: now };
      delete finished.owner_hash;
      delete finished.lease_expires_at;
      if (await this._write(finished, { etag: current.etag })) return publicJob(finished);
    }
    throw error(503, 'contention');
  }
}