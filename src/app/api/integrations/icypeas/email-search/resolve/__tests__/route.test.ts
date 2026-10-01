import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: (table: string) => mockDb.from(table) },
}));
jest.unstable_mockModule('@/lib/security/upstash-rest', () => ({
  checkRateLimit: jest.fn(), getCachedJson: jest.fn(async () => null), setCachedJson: jest.fn(async () => true),
  sha256: jest.fn(async (value: string) => createHash('sha256').update(value).digest('hex')),
}));

let POST: typeof import('../route').POST;
let checkRateLimit: typeof import('@/lib/security/upstash-rest').checkRateLimit;
let resolveEmailInput: typeof import('@/lib/integrations/icypeas/durable-email-search').resolveEmailInput;
beforeAll(async () => {
  POST = (await import('../route')).POST;
  checkRateLimit = (await import('@/lib/security/upstash-rest')).checkRateLimit;
  resolveEmailInput = (await import('@/lib/integrations/icypeas/durable-email-search')).resolveEmailInput;
});

const SITE = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const TABLE = 'icypeas_email_searches';
const SEARCH = 'icy-search_1';
const INPUT = { site_id: SITE, firstname: 'Ada', lastname: 'Lovelace', domainOrCompany: 'example.com' };
const SERVICE = { 'x-api-key-data': JSON.stringify({ id: 'service-key', isService: true }) };
type Row = Record<string, any>;
type Fault = { when: (q: Query) => boolean; commit?: boolean; throws?: boolean };
type Filter = { column: string; value: unknown; op: 'eq' | 'is' | 'lte' };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

// In-memory PostgREST adapter: mutations are atomic at execution, not query
// construction. The resolver/route/auth helpers and provider parsing are real.
class Query {
  operation = 'select';
  values: Row = {};
  filters: Filter[] = [];
  constructor(readonly db: FakeDb, readonly table: string) {}
  select(_columns: string) { return this; }
  insert(values: Row) { this.operation = 'insert'; this.values = values; return this; }
  update(values: Row) { this.operation = 'update'; this.values = values; return this; }
  eq(column: string, value: unknown) { this.filters.push({ column, value, op: 'eq' }); return this; }
  is(column: string, value: unknown) { this.filters.push({ column, value, op: 'is' }); return this; }
  lte(column: string, value: unknown) { this.filters.push({ column, value, op: 'lte' }); return this; }
  single() { return this.execute(); }
  maybeSingle() { return this.execute(); }
  then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) { return this.execute().then(resolve, reject); }
  async execute(): Promise<{ data: Row | null; error: { code: string } | null }> {
    this.db.queries.push(this);
    const index = this.db.faults.findIndex(fault => fault.when(this));
    const fault = index < 0 ? undefined : this.db.faults.splice(index, 1)[0];
    if (fault?.throws && !fault.commit) throw new Error('Offline DB');
    if (fault && !fault.commit) return { data: null, error: { code: 'OFFLINE' } };
    const rows = this.table === TABLE ? this.db.jobs : this.table === 'sites' ? this.db.sites : [];
    let found = rows.find(row => this.filters.every(({ column, value, op }) =>
      op === 'lte' ? row[column] <= value! : row[column] === value));
    if (this.operation === 'insert') {
      if (!this.db.sites.some(site => site.id === this.values.site_id)) return { data: null, error: { code: '23503' } };
      if (rows.some(row => row.site_id === this.values.site_id && row.input_hash === this.values.input_hash)) {
        return { data: null, error: { code: '23505' } };
      }
      found = { state: 'ready', status: 'READY', search_id: null, emails: [], error: null,
        poll_token: null, next_poll_at: new Date().toISOString(), ...this.values };
      rows.push(found);
    } else if (this.operation === 'update' && found) {
      Object.assign(found, this.values);
    }
    if (fault?.throws) throw new Error('Lost DB acknowledgement');
    if (fault) return { data: null, error: { code: 'OFFLINE' } };
    return { data: found ? clone(found) : null, error: null };
  }
}
class FakeDb {
  jobs: Row[] = [];
  sites: Row[] = [{ id: SITE, user_id: 'owner' }, { id: OTHER, user_id: 'other-owner' }];
  queries: Query[] = [];
  faults: Fault[] = [];
  from(table: string) { return new Query(this, table); }
}
let mockDb: FakeDb;
let provider: ReturnType<typeof jest.fn<(...args: any[]) => any>>;
const originalFetch = global.fetch;

function request(body: unknown = INPUT, headers: Record<string, string> = SERVICE) {
  return new Request('http://localhost/api/integrations/icypeas/email-search/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}
async function resolve(body: unknown = INPUT, headers?: Record<string, string>) {
  const response = await POST(request(body, headers));
  const json = await response.json();
  expect(response.headers.get('cache-control')).toBe('no-store');
  if (response.ok) {
    expect(json).toEqual({ success: true, data: expect.objectContaining({ outcome: expect.any(String), status: expect.any(String) }) });
  }
  return { response, ...json };
}
function json(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), { status, headers });
}
const ack = () => json({ success: true, item: { _id: SEARCH, status: 'NONE' } });
const result = (status: string, emails: unknown[] = [], id: unknown = SEARCH) =>
  json({ success: true, items: [{ _id: id, status, results: { emails } }] });
function due() { jest.setSystemTime(Date.now() + 10_001); }
async function submitted() {
  provider.mockResolvedValueOnce(ack());
  expect((await resolve()).data).toMatchObject({ outcome: 'pending', searchId: SEARCH, status: 'NONE' });
  due();
}
const fault = (when: Fault['when'], options: Partial<Fault> = {}) => mockDb.faults.push({ when, ...options });
const phase = (state: string) => (q: Query) => q.table === TABLE && q.operation === 'update' && q.values.state === state;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-10-02T00:00:00Z'));
  mockDb = new FakeDb();
  provider = jest.fn(async () => { throw new Error('Unexpected provider request'); });
  global.fetch = provider;
  process.env.ICYPEAS_API_KEY = 'test-raw-provider-key';
  jest.mocked(checkRateLimit).mockReset().mockImplementation(async (_key, limit, window) => ({
    configured: true, available: true, success: true, limit, remaining: limit - 1, reset: Date.now() + window * 1_000,
  }));
});
afterEach(() => { jest.useRealTimers(); global.fetch = originalFetch; delete process.env.ICYPEAS_API_KEY; });

describe('authenticated site boundary and canonical identity', () => {
  it.each([{}, { 'x-auth-user-id': 'owner' }] as Record<string, string>[])('rejects unvalidated IDs %j before storage/provider', async headers => {
    expect((await resolve(INPUT, headers)).response.status).toBe(401);
    expect(mockDb.queries).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
  });
  it('requires site ownership even for a validated user', async () => {
    expect((await resolve(INPUT, { 'x-auth-validated': 'true', 'x-auth-user-id': 'stranger' })).response.status).toBe(403);
    expect(mockDb.jobs).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
  });
  it.each([
    { 'x-auth-validated': 'true', 'x-auth-user-id': 'owner' },
    { 'x-api-key-data': JSON.stringify({ id: 'key', site_id: SITE }) },
  ] as Record<string, string>[])('allows a middleware-validated site principal %j', async headers => {
    provider.mockResolvedValueOnce(ack());
    expect((await resolve(INPUT, headers)).data.outcome).toBe('pending');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('does not allow a site key to read another site result', async () => {
    await submitted();
    expect((await resolve({ ...INPUT, site_id: OTHER }, {
      'x-api-key-data': JSON.stringify({ id: 'key', site_id: SITE }),
    })).response.status).toBe(403);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...INPUT, site_id: 'free-id' }, { ...INPUT, firstname: '', lastname: ' ' },
    { ...INPUT, domainOrCompany: ' ' }, { ...INPUT, searchId: SEARCH },
    { ...INPUT, firstname: ['Ada'] }, { ...INPUT, firstname: 'a'.repeat(201) },
    { ...INPUT, firstname: 'ada\u0000' }, { ...INPUT, custom: { externalId: 'chosen' } },
  ])('rejects malformed input %j without spending', async body => {
    expect((await resolve(body)).response.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
    expect(mockDb.jobs).toHaveLength(0);
  });
  it('rejects invalid JSON', async () => {
    const response = await POST(new Request('http://localhost', { method: 'POST', headers: SERVICE, body: '{' }));
    expect(response.status).toBe(400);
  });
  it('checks site existence through FK even for internal services', async () => {
    mockDb.sites = [];
    expect((await resolve()).response.status).toBe(404);
    expect(provider).not.toHaveBeenCalled();
  });
  it('uses one canonical tuple for submit/hash, never a cross-person/company lookup', async () => {
    provider.mockResolvedValueOnce(ack());
    await resolve({ ...INPUT, firstname: '  ADA ', lastname: ' LoveLace  ', domainOrCompany: ' EXAMPLE.COM ' });
    await resolve(INPUT);
    expect(mockDb.jobs).toHaveLength(1);
    const body = JSON.parse(provider.mock.calls[0][1].body);
    expect(body).toEqual({ firstname: 'ada', lastname: 'lovelace', domainOrCompany: 'example.com', custom: { externalId: mockDb.jobs[0].id } });
    expect(resolveEmailInput.parse({ ...INPUT, firstname: ' e\u0301 ' }).firstname).toBe('é');
    provider.mockResolvedValue(ack());
    await resolve({ ...INPUT, firstname: 'Grace' });
    await resolve({ ...INPUT, firstname: 'a', lastname: 'da lovelace' });
    await resolve({ ...INPUT, site_id: OTHER });
    expect(mockDb.jobs).toHaveLength(4);
    expect(new Set(mockDb.jobs.map(job => job.input_hash)).size).toBe(3);
    for (const q of mockDb.queries.filter(q => q.table === TABLE && q.operation !== 'insert')) {
      expect(q.filters.some(filter => filter.column === 'site_id')).toBe(true);
    }
  });
});

describe('durable submit, admission and replay', () => {
  it('inserts and claims BEFORE submit, persists ID before returning, never polls in submit request', async () => {
    provider.mockImplementationOnce(async (_url, options) => {
      expect(mockDb.jobs).toHaveLength(1);
      expect(mockDb.jobs[0].state).toBe('submitting');
      expect(options.headers.Authorization).toBe('test-raw-provider-key');
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.redirect).toBe('error');
      expect(options.cache).toBe('no-store');
      return ack();
    });
    const response = await resolve();
    expect(response.data).toEqual({ outcome: 'pending', status: 'NONE', searchId: SEARCH, retryAfterMs: 10_000 });
    expect(mockDb.jobs[0].search_id).toBe(SEARCH);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0][0]).toBe('https://app.icypeas.com/api/email-search');
    expect(checkRateLimit).toHaveBeenCalledWith('icypeas:email-search', 5, 1);
  });
  it('has exactly one paid submit during duplicate insert/claim races', async () => {
    let release!: (value: Response) => void;
    provider.mockImplementationOnce(() => new Promise<Response>(done => { release = done; }));
    const requests = Array.from({ length: 12 }, () => resolve());
    for (let turn = 0; turn < 30 && !release; turn++) await Promise.resolve();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(mockDb.jobs).toHaveLength(1);
    release(ack());
    const results = await Promise.all(requests);
    expect(results.some(value => value.data.searchId === SEARCH)).toBe(true);
    await resolve();
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each(['denied', 'unavailable', 'throws'])('leaves ready retryable on admission %s without spending', async mode => {
    if (mode === 'throws') jest.mocked(checkRateLimit).mockRejectedValueOnce(new Error('redis offline'));
    else jest.mocked(checkRateLimit).mockResolvedValueOnce({ configured: mode !== 'unavailable', available: mode !== 'unavailable',
      success: mode === 'unavailable', limit: 5, remaining: 0, reset: Date.now() + 1000 });
    const response = await resolve();
    expect(response.data.outcome).toBe('pending');
    expect(response.data.retryAfterMs).toBeGreaterThan(0);
    expect(mockDb.jobs[0].state).toBe('ready');
    expect(provider).not.toHaveBeenCalled();
    provider.mockResolvedValueOnce(ack());
    expect((await resolve()).data.searchId).toBe(SEARCH);
  });
  it.each(['select', 'insert', 'claim'])('fails closed on durable %s storage failure', async operation => {
    fault(q => q.table === TABLE && (operation === 'claim' ? q.values.state === 'submitting' : q.operation === operation));
    expect((await resolve()).response.status).toBe(503);
    expect(provider).not.toHaveBeenCalled();
  });
  it('does not submit if claim committed but acknowledgement was lost', async () => {
    fault(phase('submitting'), { commit: true });
    expect((await resolve()).response.status).toBe(503);
    expect((await resolve()).data).toMatchObject({ outcome: 'pending', status: 'SUBMITTING' });
    jest.setSystemTime(Date.now() + 30_001);
    expect((await resolve()).data.status).toBe('SUBMISSION_UNKNOWN');
    expect(provider).not.toHaveBeenCalled();
  });
  it('does not strand missing configuration in submitting', async () => {
    delete process.env.ICYPEAS_API_KEY;
    expect((await resolve()).response.status).toBe(503);
    expect(mockDb.jobs[0].state).toBe('ready');
    expect(provider).not.toHaveBeenCalled();
  });
  it.each([
    ['network', () => Promise.reject(new Error('disconnect'))],
    ['abort', () => Promise.reject(new DOMException('timeout', 'AbortError'))],
    ['5xx', () => json({ success: false }, 500)],
    ['invalid JSON', () => new Response('{broken')],
    ['missing ID', () => json({ success: true, item: { status: 'NONE' } })],
    ['missing success', () => json({ item: { _id: SEARCH } })],
    ['invalid ID', () => json({ success: true, item: { _id: '../foreign' } })],
  ] as Array<[string, () => Response | Promise<Response>]>)('never retries an ambiguous submit: %s', async (_name, response) => {
    provider.mockImplementationOnce(response);
    const first = await resolve();
    expect(first.data).toMatchObject({ outcome: 'failed', status: 'SUBMISSION_UNKNOWN', error: expect.stringContaining('manual recovery') });
    expect(mockDb.jobs[0].state).toBe('unknown');
    due();
    expect((await resolve()).data.status).toBe('SUBMISSION_UNKNOWN');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('never resubmits after ID save failure (committed=%s)', async committed => {
    provider.mockResolvedValueOnce(ack());
    fault(q => q.values.search_id === SEARCH, { commit: committed, throws: true });
    expect((await resolve()).data.status).toBe('SUBMISSION_UNKNOWN');
    due();
    provider.mockResolvedValueOnce(result('NOT_FOUND'));
    const replay = await resolve();
    expect(replay.data.outcome).toBe(committed ? 'no_match' : 'failed');
    expect(provider.mock.calls.filter(([url]) => url.endsWith('/email-search'))).toHaveLength(1);
  });
  it('retains submitting fail-closed when unknown write also fails', async () => {
    provider.mockRejectedValueOnce(new Error('disconnect'));
    fault(phase('unknown'));
    expect((await resolve()).data.status).toBe('SUBMISSION_UNKNOWN');
    expect(mockDb.jobs[0].state).toBe('submitting');
    jest.setSystemTime(Date.now() + 30_001);
    expect((await resolve()).data.error).toContain('manual recovery');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each([
    [402, { success: false }, 'INSUFFICIENT_FUNDS'],
    [429, { success: false }, 'PROVIDER_RATE_LIMITED'],
    [401, { success: false }, 'PROVIDER_AUTH_ERROR'],
    [200, { success: false, code: 'INSUFFICIENT_FUNDS' }, 'INSUFFICIENT_FUNDS'],
    [200, { success: false, validationErrors: [{}] }, 'PROVIDER_REJECTED'],
  ])('caches explicit rejection %s, no paid retry', async (http, payload, status) => {
    provider.mockResolvedValueOnce(json(payload, http as number));
    const first = await resolve();
    expect(first.data).toMatchObject({ outcome: 'failed', status });
    expect((await resolve()).data).toEqual(first.data);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe('single-step result reads and monotonic terminals', () => {
  it.each(['NONE', 'SCHEDULED', 'IN_PROGRESS'])('keeps %s pending; polls same ID only when due', async status => {
    await submitted();
    provider.mockResolvedValueOnce(result(status));
    expect((await resolve()).data).toMatchObject({ outcome: 'pending', status, searchId: SEARCH });
    await resolve();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[1][0]).toBe('https://app.icypeas.com/api/bulk-single-searchs/read');
    expect(JSON.parse(provider.mock.calls[1][1].body)).toEqual({ id: SEARCH });
    expect(checkRateLimit).toHaveBeenLastCalledWith('icypeas:result-read', 15, 60);
  });
  it.each(['FOUND', 'DEBITED'])('caches %s with certainty, never inventing verification', async status => {
    await submitted();
    provider.mockResolvedValueOnce(result(status, [
      { email: 'ada@example.com', certainty: 'ultra_sure', mxProvider: 'google', verified: true },
      { email: 'ada+alt@example.com', certainty: 'probable' },
    ]));
    const first = await resolve();
    expect(first.data).toEqual({ outcome: 'matched', status, searchId: SEARCH, email: 'ada@example.com', emails: [
      { email: 'ada@example.com', certainty: 'ultra_sure' }, { email: 'ada+alt@example.com', certainty: 'probable' },
    ] });
    delete process.env.ICYPEAS_API_KEY;
    expect((await resolve()).data).toEqual(first.data);
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it.each(['NOT_FOUND', 'DEBITED_NOT_FOUND', 'BAD_INPUT', 'INSUFFICIENT_FUNDS', 'ABORTED'])('caches %s terminal results', async status => {
    await submitted();
    provider.mockResolvedValueOnce(result(status));
    const first = await resolve();
    expect(first.data).toMatchObject({ outcome: status.includes('NOT_FOUND') ? 'no_match' : 'failed', searchId: SEARCH, status });
    expect((await resolve()).data).toEqual(first.data);
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it.each([
    { success: true, items: [] }, { success: true, item: { _id: SEARCH } },
    { success: true, items: [{ _id: 'wrong-id', status: 'NOT_FOUND', results: { emails: [] } }] },
    { success: true, items: [{ status: 'FOUND', results: { emails: [] } }] },
    { success: true, items: [{ _id: SEARCH, status: 'ALIEN' }] },
    { success: true, items: [{ _id: SEARCH, status: 'FOUND' }] },
    { success: true, items: [{ _id: SEARCH, status: 'NOT_FOUND' }] },
    { success: false },
  ])('malformed/error/unknown ID is never no_match: %j', async payload => {
    await submitted();
    provider.mockResolvedValueOnce(json(payload));
    expect((await resolve()).data).toMatchObject({ outcome: 'failed', searchId: SEARCH, error: expect.any(String) });
    await resolve();
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it.each([
    [], [{ email: 'broken' }], [{ email: 'a..b@example.com' }], [{ email: 'a@-example.com' }],
    [{ email: 'ada@example.com', certainty: true }], [{ email: 'ada@example.com\n' }],
    Array.from({ length: 21 }, () => ({ email: 'ada@example.com' })),
  ].map(emails => [emails]))('rejects malformed found email arrays', async emails => {
    await submitted();
    provider.mockResolvedValueOnce(result('FOUND', emails));
    expect((await resolve()).data).toMatchObject({ outcome: 'failed', status: 'PROVIDER_MALFORMED' });
  });
  it('rejects a contradictory no-match response containing an email', async () => {
    await submitted();
    provider.mockResolvedValueOnce(result('NOT_FOUND', [{ email: 'ada@example.com' }]));
    expect((await resolve()).data.outcome).toBe('failed');
  });
  it('permits syntax-valid missing certainty without asserting verified', async () => {
    await submitted();
    provider.mockResolvedValueOnce(result('FOUND', [{ email: 'ada@example.com' }]));
    expect((await resolve()).data.emails).toEqual([{ email: 'ada@example.com' }]);
  });
  it.each([429, 503])('read HTTP %s stays pending with ID and backoff, never another search', async status => {
    await submitted();
    provider.mockResolvedValueOnce(json({ success: false }, status, { 'retry-after': '120' }));
    expect((await resolve()).data).toMatchObject({ outcome: 'pending', searchId: SEARCH, retryAfterMs: 120_000 });
    due();
    await resolve();
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it.each(['network', 'json'])('read %s failure can retry reads only', async failure => {
    await submitted();
    if (failure === 'network') provider.mockRejectedValueOnce(new Error('offline'));
    else provider.mockResolvedValueOnce(new Response('{bad'));
    expect((await resolve()).data).toMatchObject({ outcome: 'pending', status: 'READ_UNAVAILABLE', searchId: SEARCH });
    due();
    provider.mockResolvedValueOnce(result('NOT_FOUND'));
    expect((await resolve()).data.outcome).toBe('no_match');
    expect(provider.mock.calls.filter(([url]) => url.endsWith('/email-search'))).toHaveLength(1);
  });
  it.each(['7200', 'Fri, 02 Oct 2026 02:00:10 GMT'])('honors upstream Retry-After %s without shortening it', async retry => {
    await submitted();
    provider.mockResolvedValueOnce(json({ success: false }, 429, { 'retry-after': retry }));
    const first = await resolve();
    expect(first.data.outcome).toBe('pending');
    expect(first.data.retryAfterMs).toBeGreaterThan(7_199_000);
    jest.setSystemTime(Date.now() + 3_600_000);
    await resolve();
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it('fails closed on an unrepresentable upstream cooldown', async () => {
    await submitted();
    provider.mockResolvedValueOnce(json({ success: false }, 429, { 'retry-after': '9'.repeat(100) }));
    expect((await resolve()).data).toMatchObject({ outcome: 'failed', status: 'PROVIDER_INVALID_RETRY_AFTER', searchId: SEARCH });
    await resolve();
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it('does not call provider when poll admission storage is unavailable', async () => {
    await submitted();
    jest.mocked(checkRateLimit).mockResolvedValueOnce({ configured: false, available: false, success: true, limit: 15, remaining: 15, reset: Date.now() + 60_000 });
    expect((await resolve()).data).toMatchObject({ outcome: 'pending', searchId: SEARCH, status: 'RATE_LIMIT_UNAVAILABLE' });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('fails closed when poll CAS cannot be acknowledged', async () => {
    await submitted();
    fault(q => Boolean(q.values.poll_token), { commit: true });
    expect((await resolve()).response.status).toBe(503);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('has only one read winner per 10 seconds under concurrent polls', async () => {
    await submitted();
    provider.mockResolvedValue(result('IN_PROGRESS'));
    await Promise.all(Array.from({ length: 12 }, () => resolve()));
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it('an old pending response cannot overwrite a newer terminal result', async () => {
    await submitted();
    let release!: (value: Response) => void;
    provider.mockImplementationOnce(() => new Promise<Response>(done => { release = done; }));
    const slow = resolve();
    for (let turn = 0; turn < 30 && !release; turn++) await Promise.resolve();
    due();
    provider.mockResolvedValueOnce(result('FOUND', [{ email: 'ada@example.com', certainty: 'very_sure' }]));
    const winner = await resolve();
    expect(winner.data.outcome).toBe('matched');
    release(result('IN_PROGRESS'));
    expect((await slow).data).toEqual(winner.data);
    expect(mockDb.jobs[0].state).toBe('matched');
  });
  it('does not report a terminal result until its storage is acknowledged', async () => {
    await submitted();
    provider.mockResolvedValueOnce(result('FOUND', [{ email: 'ada@example.com' }]));
    fault(phase('matched'));
    expect((await resolve()).response.status).toBe(503);
    expect(mockDb.jobs[0].state).toBe('pending');
    due();
    provider.mockResolvedValueOnce(result('FOUND', [{ email: 'ada@example.com' }]));
    expect((await resolve()).data.outcome).toBe('matched');
    expect(provider.mock.calls.filter(([url]) => url.endsWith('/email-search'))).toHaveLength(1);
  });
});