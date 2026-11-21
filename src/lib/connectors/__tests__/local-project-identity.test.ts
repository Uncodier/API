import { randomBytes, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const ref = 'a'.repeat(20), other = 'b'.repeat(20);
const canonical = `https://${ref}.supabase.co`, alias = 'https://data.example.com';
const rpc = 'connector_catalog_read_actor', path = `/rest/v1/rpc/${rpc}`;
const args = { p_user_id: randomUUID(), p_site_id: randomUUID(), p_agent_id: randomUUID(), p_instance_id: randomUUID() };
const mockCname = jest.fn<Promise<string[]>, [string]>(), mockCancel = jest.fn();
jest.mock('node:dns/promises', () => ({ Resolver: jest.fn(() => ({ resolveCname: mockCname, cancel: mockCancel })) }));

const config = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'];
let original: (string | undefined)[];
let http: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>;
const noProof = { allowed: true, localProjectRef: null };
const proven = { allowed: true, localProjectRef: ref };

// Use the installed official SDK and real lazy singleton. Only the external boundaries are mocked.
function load(url = canonical) {
  jest.resetModules();
  process.env.SUPABASE_URL = url;
  const { supabaseAdmin: admin, getSupabaseAdmin, getSupabase } = require('@/lib/database/supabase-client') as typeof import('@/lib/database/supabase-client');
  const { withCatalogActorEvidence: capture } = require('@/lib/database/hosted-project-identity') as typeof import('@/lib/database/hosted-project-identity');
  const read = async (client: SupabaseClient = admin) => {
    const { data, error } = await client.rpc(rpc, args).abortSignal(AbortSignal.timeout(5000));
    if (error || typeof data !== 'boolean') throw new Error('Actor check failed');
    return data;
  };
  return { admin, getSupabaseAdmin, getSupabase, capture, read, check: () => capture(read) };
}

function response(url: string, header: string | null = null, body = 'true', status = 200, redirected = false) {
  const res = new Response(body, { status, headers: header === null ? {} : { 'sb-project-ref': header } });
  // A constructed Response has an empty URL. Simulate the URL supplied by the real fetch transport.
  return Object.defineProperties(res, { url: { value: url }, redirected: { value: redirected } });
}
function gateway(header: string | null = null, body = 'true') {
  http.mockImplementation(async url => response(String(url), header, body));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}

beforeEach(() => {
  original = config.map(k => process.env[k]);
  process.env.NEXT_PUBLIC_SUPABASE_URL = canonical;
  process.env.SUPABASE_SERVICE_ROLE_KEY = `sb_secret_${randomBytes(32).toString('base64url')}`;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = `sb_publishable_${randomBytes(32).toString('base64url')}`;
  http = jest.spyOn(globalThis, 'fetch');
  gateway();
  mockCname.mockReset().mockResolvedValue([`${ref}.supabase.co`]); mockCancel.mockReset();
});
afterEach(() => {
  jest.useRealTimers(); jest.restoreAllMocks();
  config.forEach((k, i) => { if (original[i] === undefined) delete process.env[k]; else process.env[k] = original[i]; });
});

test('canonical identity requires the actual authorized POST, allows a missing header, and keeps SDK auth intact', async () => {
  const f = load(`${canonical}/`);
  expect(await f.capture(async () => true)).toEqual(noProof);
  expect(await f.check()).toEqual(proven);
  gateway(ref); expect(await f.check()).toEqual(proven);
  for (const [input, init] of http.mock.calls) {
    expect(input).toBe(canonical + path);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(args), redirect: 'error', cache: 'no-store' });
    const headers = new Headers(init?.headers);
    expect(headers.get('apikey') === process.env.SUPABASE_SERVICE_ROLE_KEY).toBe(true);
    expect(headers.get('authorization') === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`).toBe(true);
  }
  expect(http).toHaveBeenCalledTimes(2); expect(mockCname).not.toHaveBeenCalled();
});

test('canonical evidence is bound to the initialized client, not changed env or a different Supabase client', async () => {
  const f = load(canonical); f.getSupabaseAdmin();
  process.env.SUPABASE_URL = alias;
  expect(await f.check()).toEqual(proven);
  const client = f.getSupabase();
  try { expect(await f.capture(() => f.read(client))).toEqual(noProof); }
  finally { client.auth.stopAutoRefresh(); }
  expect(http.mock.calls.map(([u]) => u)).toEqual([canonical + path, canonical + path]);
  expect(http.mock.calls[1][1]?.redirect).toBeUndefined(); expect(mockCname).not.toHaveBeenCalled();
});

test('canonical/custom origins reject malformed, duplicate and contradictory gateway refs', async () => {
  for (const url of [canonical, alias]) {
    const f = load(url);
    for (const bad of ['', 'a'.repeat(19), ref + '1', ref.toUpperCase(), ref + ',' + ref, ref + ', ' + other]) {
      gateway(bad); expect(await f.check()).toEqual(noProof);
    }
    if (url === canonical) { gateway(other); expect(await f.check()).toEqual(noProof); }
    else { gateway(null); expect(await f.check()).toEqual(noProof); }
  }
  expect(mockCname).not.toHaveBeenCalled();
});

test.each(['opaque', 'legacy'])('custom alias requires a single matching direct CNAME regardless of SDK key format (%s)', async kind => {
  if (kind === 'legacy') {
    const segment = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    process.env.SUPABASE_SERVICE_ROLE_KEY = `${segment({ alg: 'HS256' })}.${segment({ role: 'service_role', ref: other })}.${randomBytes(32).toString('base64url')}`;
  }
  const f = load(alias); gateway(ref);
  mockCname.mockResolvedValueOnce([`${ref}.SUPABASE.CO.`]);
  expect(await f.check()).toEqual(proven);
  expect(http.mock.calls.map(([url]) => url)).toEqual([alias + path]);
  expect(mockCname.mock.calls).toEqual([['data.example.com.']]);
  for (const targets of [[], [`${ref}.supabase.co`, `${ref}.supabase.co`], [`${other}.supabase.co`], ['hop.example.com'],
    [`sub.${ref}.supabase.co`], [`${ref}.supabase.co.example.com`], [`${ref}.supabase.co..`]]) {
    mockCname.mockResolvedValueOnce(targets); expect(await f.check()).toEqual(noProof);
  }
  mockCname.mockRejectedValueOnce(new Error('DNS unavailable')); expect(await f.check()).toEqual(noProof);
});

test('does not normalize ambiguous or non-public configured authorities into proof', async () => {
  for (const bad of [`http://${ref}.supabase.co`, `${canonical}:443`, `${canonical}/.`, `${canonical}/prefix`, `${alias}#`,
    'https://a.svc.internal', 'https://127.0.0.1', 'https://sub.vanity.supabase.co', 'https://unverified.supabase.in']) {
    gateway(ref); expect(await load(bad).check()).toEqual(noProof);
  }
  expect(mockCname).not.toHaveBeenCalled();
});

test('response URL, 200 status and no redirect are mandatory; actor denial or RPC failure never starts DNS', async () => {
  const f = load(alias), url = alias + path;
  for (const res of [response('', ref), response(canonical + path, ref), response(url + '?select=*', ref),
    response(url, ref, 'true', 200, true), response(url, ref, 'true', 201)]) {
    http.mockResolvedValueOnce(res); expect(await f.check()).toEqual(noProof);
  }
  gateway(ref, 'false'); expect(await f.check()).toEqual({ allowed: false, localProjectRef: null });
  for (const res of [response(url, ref, '{}', 302), response(url, ref, '{}', 403), response(url, ref, '"true"')]) {
    http.mockResolvedValueOnce(res); await expect(f.check()).rejects.toThrow('Actor check failed');
  }
  http.mockRejectedValueOnce(new TypeError('unexpected redirect')); await expect(f.check()).rejects.toThrow('Actor check failed');
  expect(mockCname).not.toHaveBeenCalled();
});

test('other methods/paths/queries/schemas and calls outside the dynamic scope pass through unmodified', async () => {
  const f = load(alias); gateway(ref);
  expect(await f.read()).toBe(true);
  for (const query of [f.admin.rpc(rpc, {}, { get: true }), f.admin.rpc(rpc + '_other', args),
    f.admin.rpc(rpc, args).select('id'), f.admin.schema('private').rpc(rpc, args)]) {
    expect(await f.capture(async () => (await query).data === true)).toEqual(noProof);
  }
  expect(await f.capture(async () => (await fetch(alias + path, { method: 'POST' })).ok)).toEqual(noProof);
  for (const [, init] of http.mock.calls) {
    expect(init?.redirect).toBeUndefined(); expect(init?.cache).toBeUndefined();
  }
  expect(mockCname).not.toHaveBeenCalled();
});

test('does not combine two RPCs, a previous success, or detached work with an actor check', async () => {
  const f = load(alias); gateway(ref);
  expect(await f.capture(async () => (await f.read()) && (await f.read()))).toEqual(noProof);
  const start = deferred<void>(); let late!: Promise<boolean>;
  expect(await f.capture(async () => { late = start.promise.then(() => f.read()); return true; })).toEqual(noProof);
  start.resolve(); expect(await late).toBe(true);
  expect(http.mock.calls.at(-1)?.[1]?.redirect).toBeUndefined();
  expect(await f.capture(async () => true)).toEqual(noProof);
  expect(mockCname).not.toHaveBeenCalled();
});

test('overlapping operations use only their own gateway response, even when the valid check resolves last', async () => {
  const f = load(alias), sent = deferred<void>(), finish = deferred<Response>();
  gateway(null); http.mockImplementationOnce(() => { sent.resolve(); return finish.promise; });
  const first = f.check(); await sent.promise;
  expect(await f.check()).toEqual(noProof);
  finish.resolve(response(alias + path, ref)); expect(await first).toEqual(proven);
  expect(await f.check()).toEqual(noProof); expect(mockCname).toHaveBeenCalledTimes(1);
});

test('after authorization a wedged lookup has a wall-clock deadline and cannot seed another request', async () => {
  jest.useFakeTimers();
  const f = load(alias), started = deferred<void>(), late = deferred<string[]>(); gateway(ref);
  mockCname.mockImplementationOnce(() => { started.resolve(); return late.promise; });
  const slow = f.check(); await started.promise; await jest.advanceTimersByTimeAsync(1500);
  expect(await slow).toEqual(noProof); expect(mockCancel).toHaveBeenCalledTimes(1);
  late.resolve([`${ref}.supabase.co`]); mockCname.mockResolvedValueOnce([]);
  expect(await f.check()).toEqual(noProof); expect(mockCname).toHaveBeenCalledTimes(2);
});
