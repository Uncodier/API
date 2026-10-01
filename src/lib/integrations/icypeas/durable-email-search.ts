import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { checkRateLimit } from '@/lib/security/upstash-rest';

const TABLE = 'icypeas_email_searches';
const BASE_URL = 'https://app.icypeas.com/api';
const POLL_MS = 10_000;
const MAX_EMAILS = 20;
const MAX_RESPONSE_CHARS = 131_072;
const SEARCH_ID = /^[A-Za-z0-9_-]{1,200}$/;
const TERMINAL = new Set(['matched', 'no_match', 'failed']);

// One canonical tuple is used for BOTH identity and the provider request. Do not
// strip accents/punctuation, merge name fields or fall back to a company lookup.
const canonical = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const text = (max: number) => z.string().max(max)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed')
  .transform(canonical);

export const resolveEmailInput = z.object({
  site_id: z.string().uuid().transform(value => value.toLowerCase()),
  firstname: text(200).optional().default(''),
  lastname: text(200).optional().default(''),
  domainOrCompany: text(500).refine(value => value.length > 0),
}).strict().refine(value => Boolean(value.firstname || value.lastname), {
  message: 'At least one name is required',
});

type Input = z.infer<typeof resolveEmailInput>;
export type Email = { email: string; certainty?: string };
export type Resolution = {
  outcome: 'pending' | 'matched' | 'no_match' | 'failed';
  searchId?: string;
  status: string;
  email?: string;
  emails?: Email[];
  retryAfterMs?: number;
  error?: string;
};
type State = 'ready' | 'submitting' | 'unknown' | Resolution['outcome'];
type Job = {
  id: string;
  site_id: string;
  input_hash: string;
  firstname: string;
  lastname: string;
  domain_or_company: string;
  state: State;
  search_id: string | null;
  status: string;
  emails: Email[];
  error: string | null;
  next_poll_at: string;
  poll_token: string | null;
  updated_at: string;
};
type Patch = Partial<Pick<Job, 'state' | 'search_id' | 'status' | 'emails' | 'error' | 'next_poll_at' | 'poll_token'>>;

export class EmailSearchError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 503) {
    super(message);
    Object.setPrototypeOf(this, EmailSearchError.prototype);
  }
}

function storageError(): EmailSearchError {
  return new EmailSearchError('STORAGE_UNAVAILABLE', 'Durable IcyPeas storage is unavailable; no new submission is permitted');
}

function updateJob(job: Job, patch: Patch) {
  return supabaseAdmin.from(TABLE).update({ ...patch, updated_at: new Date().toISOString() })
    .eq('site_id', job.site_id).eq('id', job.id);
}

async function readJob(siteId: string, hash: string): Promise<Job | null> {
  const { data, error } = await supabaseAdmin.from(TABLE).select('*')
    .eq('site_id', siteId).eq('input_hash', hash).maybeSingle();
  if (error) throw storageError();
  return data as Job | null;
}

async function getOrCreateJob(input: Input): Promise<Job> {
  const hash = createHash('sha256')
    .update(JSON.stringify(['v1', input.firstname, input.lastname, input.domainOrCompany])).digest('hex');
  const existing = await readJob(input.site_id, hash);
  if (existing) return existing;
  const { data, error } = await supabaseAdmin.from(TABLE).insert({
    id: randomUUID(), site_id: input.site_id, input_hash: hash,
    firstname: input.firstname, lastname: input.lastname, domain_or_company: input.domainOrCompany,
  }).select('*').single();
  if (error?.code === '23503') {
    throw new EmailSearchError('SITE_NOT_FOUND', 'The authorized site does not exist', 404);
  }
  if (error?.code === '23505') {
    const winner = await readJob(input.site_id, hash);
    if (winner) return winner;
  }
  if (error || !data) throw storageError();
  return data as Job;
}

function snapshot(job: Job): Resolution {
  const search = job.search_id ? { searchId: job.search_id } : {};
  if (job.state === 'submitting' && Date.now() - Date.parse(job.updated_at) < 30_000) {
    // A concurrent caller must not trigger a fallback while the sole owner is
    // still submitting. This is presentation only, never a reclaim/reset lease.
    return { outcome: 'pending', status: 'SUBMITTING', retryAfterMs: POLL_MS };
  }
  if (job.state === 'submitting' || job.state === 'unknown') {
    return { outcome: 'failed', status: 'SUBMISSION_UNKNOWN', ...search,
      error: job.error || `Submission is in flight or its outcome is unknown; manual recovery required for job ${job.id}. Never resubmit.` };
  }
  if (job.state === 'matched') {
    return { outcome: 'matched', status: job.status, ...search, email: job.emails[0].email, emails: job.emails };
  }
  if (job.state === 'failed' || job.state === 'no_match') {
    return { outcome: job.state, status: job.status, ...search, ...(job.error ? { error: job.error } : {}) };
  }
  return { outcome: 'pending', status: job.status, ...search,
    retryAfterMs: Math.max(1_000, Date.parse(job.next_poll_at) - Date.now()),
    ...(job.error ? { error: job.error } : {}) };
}

async function current(job: Job): Promise<Resolution> {
  const row = await readJob(job.site_id, job.input_hash);
  if (!row) throw storageError();
  return snapshot(row);
}

async function admission(kind: 'email-search' | 'result-read'): Promise<Resolution | null> {
  // Global provider-account buckets, not per-user/site/process. The existing
  // limiter is fixed-window; half-capacity bounds adjacent-window bursts at the
  // official 10/sec and 30/min limits, including all resolver instances.
  const seconds = kind === 'email-search' ? 1 : 60;
  try {
    const decision = await checkRateLimit(`icypeas:${kind}`, kind === 'email-search' ? 5 : 15, seconds);
    if (decision.available && decision.configured && decision.success) return null;
    return { outcome: 'pending', status: decision.available ? 'RATE_LIMITED' : 'RATE_LIMIT_UNAVAILABLE',
      retryAfterMs: Math.max(POLL_MS, decision.reset - Date.now()),
      ...(!decision.available ? { error: 'Shared provider rate-limit storage is unavailable; provider was not called' } : {}) };
  } catch {
    return { outcome: 'pending', status: 'RATE_LIMIT_UNAVAILABLE', retryAfterMs: seconds * 1_000 + POLL_MS,
      error: 'Shared provider rate-limit storage is unavailable; provider was not called' };
  }
}

async function providerRequest(path: string, body: object, apiKey: string) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new Error('Oversized provider response');
  const payload: unknown = JSON.parse(text);
  return { response, payload };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

async function submissionUnknown(job: Job, reason: string): Promise<Resolution> {
  const error = `${reason}; manual recovery required for job ${job.id}. Never resubmit.`;
  try {
    // Best effort only: an unacknowledged write may already have committed.
    // Never overwrite a persisted search ID, a terminal result or a later poll.
    await updateJob(job, { state: 'unknown', status: 'SUBMISSION_UNKNOWN', error })
      .eq('state', 'submitting').is('search_id', null);
  } catch { /* The durable submitting marker itself prevents another submit. */ }
  return { outcome: 'failed', status: 'SUBMISSION_UNKNOWN', error };
}

async function submit(job: Job, apiKey: string): Promise<Resolution> {
  const limited = await admission('email-search');
  if (limited) return limited; // Remains ready, never stranded by a limiter.
  const { data, error } = await updateJob(job, { state: 'submitting', status: 'SUBMITTING' })
    .eq('state', 'ready').is('search_id', null).select('*').maybeSingle();
  if (error) throw storageError(); // Unacknowledged claim: MUST NOT send.
  if (!data) return current(job); // Exactly one durable CAS winner can send.

  let result: Awaited<ReturnType<typeof providerRequest>>;
  try {
    result = await providerRequest('/email-search', {
      firstname: job.firstname, lastname: job.lastname, domainOrCompany: job.domain_or_company,
      custom: { externalId: job.id },
    }, apiKey);
  } catch {
    return submissionUnknown(job, 'Provider submission acknowledgement is unavailable or malformed');
  }
  const { response, payload } = result;
  if (response.status >= 500 || response.status === 408) {
    return submissionUnknown(job, `Provider submission HTTP ${response.status} is ambiguous`);
  }
  if (!response.ok || (object(payload) && payload.success === false)) {
    const status = rejectionStatus(response.status, payload);
    try {
      const saved = await updateJob(job, { state: 'failed', status, error: `Provider rejected submission (${status}); no automatic retry` })
        .eq('state', 'submitting').is('search_id', null).select('*').maybeSingle();
      if (saved.error || !saved.data) return submissionUnknown(job, 'Submission rejection could not be stored');
      return snapshot(saved.data as Job);
    } catch { return submissionUnknown(job, 'Submission rejection could not be stored'); }
  }
  if (!object(payload) || payload.success !== true || !object(payload.item)
    || typeof payload.item._id !== 'string' || !SEARCH_ID.test(payload.item._id)
    || /\s/.test(payload.item._id)) {
    return submissionUnknown(job, 'Provider accepted no valid search ID');
  }
  const searchId = payload.item._id;
  try {
    // No read/poll in this request. Persist the acknowledged ID BEFORE success.
    const saved = await updateJob(job, { state: 'pending', search_id: searchId, status: 'NONE',
      next_poll_at: new Date(Date.now() + POLL_MS).toISOString(), error: null })
      .eq('state', 'submitting').is('search_id', null).select('*').maybeSingle();
    if (saved.error || !saved.data) return submissionUnknown(job, `Could not confirm persistence of provider search ${searchId}`);
    return snapshot(saved.data as Job);
  } catch { return submissionUnknown(job, `Could not confirm persistence of provider search ${searchId}`); }
}

function rejectionStatus(httpStatus: number, payload: unknown): string {
  // Do not echo arbitrary provider messages/PII/secrets into public errors.
  const code = object(payload) ? (payload.code ?? payload.error) : null;
  if (httpStatus === 402 || code === 'INSUFFICIENT_FUNDS') return 'INSUFFICIENT_FUNDS';
  if (httpStatus === 429) return 'PROVIDER_RATE_LIMITED';
  if (httpStatus === 401 || httpStatus === 403) return 'PROVIDER_AUTH_ERROR';
  return 'PROVIDER_REJECTED';
}

function validEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254 || /\s/.test(value)) return false;
  const parts = value.split('@');
  const [local, domain] = parts;
  return parts.length === 2 && Boolean(local && domain) && local.length <= 64
    && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    && domain.includes('.') && domain.split('.').every(label =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function failed(status: string): Patch {
  return { state: 'failed', status, error: `IcyPeas result could not be resolved (${status}); never start a replacement search` };
}

function parseResult(payload: unknown, searchId: string): Patch {
  // Official /bulk-single-searchs/read envelope is items[], even for { id }.
  if (!object(payload) || payload.success !== true || !Array.isArray(payload.items)
    || payload.items.length !== 1 || !object(payload.items[0])) return failed('PROVIDER_MALFORMED');
  const item = payload.items[0];
  if (typeof item._id !== 'string' || item._id !== searchId) return failed('PROVIDER_ID_MISMATCH');
  const status = item.status;
  if (typeof status !== 'string') return failed('PROVIDER_MALFORMED');
  if (['NONE', 'SCHEDULED', 'IN_PROGRESS'].includes(status)) return { state: 'pending', status, error: null };
  if (['BAD_INPUT', 'INSUFFICIENT_FUNDS', 'ABORTED'].includes(status)) return failed(status);
  if (!['FOUND', 'DEBITED', 'NOT_FOUND', 'DEBITED_NOT_FOUND'].includes(status)) return failed('PROVIDER_UNKNOWN_STATUS');
  if (!object(item.results) || !Array.isArray(item.results.emails)) return failed('PROVIDER_MALFORMED');
  const values = item.results.emails;
  if (status === 'NOT_FOUND' || status === 'DEBITED_NOT_FOUND') {
    return values.length === 0 ? { state: 'no_match', status, error: null } : failed('PROVIDER_MALFORMED');
  }
  if (!values.length || values.length > MAX_EMAILS) return failed('PROVIDER_MALFORMED');
  const emails: Email[] = [];
  for (const entry of values) {
    if (!object(entry) || !validEmail(entry.email) || (entry.certainty !== undefined
      && (typeof entry.certainty !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(entry.certainty)
        || /\s/.test(entry.certainty)))) return failed('PROVIDER_MALFORMED');
    emails.push({ email: entry.email, ...(typeof entry.certainty === 'string' ? { certainty: entry.certainty } : {}) });
  }
  return { state: 'matched', status, emails, error: null };
}

async function savePoll(job: Job, token: string, patch: Patch): Promise<Resolution> {
  const { data, error } = await updateJob(job, patch).eq('state', 'pending')
    .eq('search_id', job.search_id!).eq('poll_token', token).select('*').maybeSingle();
  if (error) throw storageError();
  return data ? snapshot(data as Job) : current(job);
}

async function poll(job: Job, apiKey: string): Promise<Resolution> {
  if (Date.parse(job.next_poll_at) > Date.now()) return snapshot(job);
  const token = randomUUID();
  const now = Date.now();
  const { data, error } = await updateJob(job, { poll_token: token, next_poll_at: new Date(now + POLL_MS).toISOString() })
    .eq('state', 'pending').eq('search_id', job.search_id!)
    .eq('next_poll_at', job.next_poll_at).lte('next_poll_at', new Date(now).toISOString()).select('*').maybeSingle();
  if (error) throw storageError();
  if (!data) return current(job);
  const limited = await admission('result-read');
  if (limited) {
    return savePoll(job, token, { status: limited.status, error: limited.error || null,
      next_poll_at: new Date(Date.now() + limited.retryAfterMs!).toISOString() });
  }
  let result: Awaited<ReturnType<typeof providerRequest>>;
  try { result = await providerRequest('/bulk-single-searchs/read', { id: job.search_id }, apiKey); }
  catch {
    return savePoll(job, token, { status: 'READ_UNAVAILABLE', error: 'Provider read unavailable or invalid JSON; only this existing search ID may be polled' });
  }
  const { response, payload } = result;
  if (response.status === 429 || response.status >= 500 || response.status === 408) {
    const retryHeader = response.headers.get('retry-after');
    const retryAt = retryHeader && /^\d+$/.test(retryHeader)
      ? Date.now() + Number(retryHeader) * 1_000
      : retryHeader ? Date.parse(retryHeader) : NaN;
    // Never shorten a valid upstream cooldown. Unrepresentable dates fail
    // closed instead of accidentally resuming reads or starting another search.
    if (retryHeader && /^\d+$/.test(retryHeader) && !Number.isFinite(new Date(retryAt).getTime())) {
      return savePoll(job, token, failed('PROVIDER_INVALID_RETRY_AFTER'));
    }
    const nextPoll = Number.isFinite(retryAt) ? Math.max(Date.now() + POLL_MS, retryAt) : Date.now() + 60_000;
    return savePoll(job, token, { status: response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'READ_UNAVAILABLE',
      error: `Provider read HTTP ${response.status}; retry reads only`,
      next_poll_at: new Date(nextPoll).toISOString() });
  }
  const patch = !response.ok || (object(payload) && payload.success === false)
    ? failed(rejectionStatus(response.status, payload)) : parseResult(payload, job.search_id!);
  return savePoll(job, token, patch);
}

/** Server-only entry point. Caller MUST authorize input.site_id first. */
export async function resolveDurableEmailSearch(input: Input): Promise<Resolution> {
  try {
    const job = await getOrCreateJob(input);
    if (TERMINAL.has(job.state) || job.state === 'submitting' || job.state === 'unknown') return snapshot(job);
    const apiKey = process.env.ICYPEAS_API_KEY;
    if (!apiKey?.trim()) throw new EmailSearchError('CONFIGURATION_ERROR', 'IcyPeas API key is not configured');
    if (job.state === 'ready') return await submit(job, apiKey);
    if (job.state === 'pending' && job.search_id) return await poll(job, apiKey);
    throw storageError();
  } catch (error) {
    if (error instanceof EmailSearchError) throw error;
    throw storageError();
  }
}