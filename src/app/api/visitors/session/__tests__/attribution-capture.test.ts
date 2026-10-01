// @ts-nocheck -- Dynamic ESM Jest mocks under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const siteId = '9be0a6a2-5567-41bf-ad06-cb4014f0faf2';
const landingUrl = 'https://www.makinari.com/?utm_source=Google&utm_medium=cpc'
  + '&utm_campaign=Summer+Launch&utm_term=visitor%20tracking&utm_content=hero%2Bcta';
const attribution = {
  utm_source: 'Google', utm_medium: 'cpc', utm_campaign: 'Summer Launch',
  utm_term: 'visitor tracking', utm_content: 'hero+cta',
};
const emptyAttribution = Object.fromEntries(Object.keys(attribution).map(key => [key, null]));
const sessions: Record<string, any>[] = [];
const visitors: Record<string, any>[] = [];
const writes: { table: string; operation: string; data: Record<string, any> }[] = [];

// All persistence, rate limiting, live state and geolocation stay in memory.
const from = jest.fn((table: string) => {
  if (!['visitors', 'visitor_sessions'].includes(table)) throw new Error(`Unexpected table: ${table}`);
  const rows = table === 'visitors' ? visitors : sessions;
  const filters: Record<string, unknown> = {};
  let updated: Record<string, any> | null = null;
  let inserted: Record<string, any> | null = null;
  const execute = () => {
    const row = inserted || rows.find(candidate =>
      Object.entries(filters).every(([key, value]) => candidate[key] === value)) || null;
    if (updated && row) {
      writes.push({ table, operation: 'update', data: { ...updated } });
      Object.assign(row, updated);
    }
    return { data: row, error: null };
  };
  const query: any = {
    select: () => query,
    eq: (key: string, value: unknown) => { filters[key] = value; return query; },
    order: () => query,
    limit: () => query,
    insert: (values: Record<string, any>[]) => {
      inserted = { ...values[0] };
      rows.push(inserted);
      writes.push({ table, operation: 'insert', data: { ...inserted } });
      return query;
    },
    update: (values: Record<string, any>) => { updated = values; return query; },
    maybeSingle: async () => execute(),
    single: async () => execute(),
    then: (resolve, reject) => Promise.resolve(execute()).then(resolve, reject),
  };
  return query;
});
const rpc = jest.fn();
const recordVisitorHeartbeat = jest.fn(async () => null);
const cacheVisitorSession = jest.fn(async () => undefined);

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from, rpc } }));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit: async () => null, hasAuthenticatedPrincipal: () => false,
}));
jest.unstable_mockModule('@/lib/security/site-access', () => ({
  canAccessSite: async () => false,
  originBelongsToSite: async (request: Request, id: string) =>
    request.headers.get('origin') === 'https://www.makinari.com' && id === siteId,
}));
jest.unstable_mockModule('@/lib/services/visitor-session-live-state', () => ({
  closeVisitorLiveState: async () => undefined,
  readCachedVisitorSession: async () => null,
  readVisitorHeartbeat: async () => ({}),
  recordVisitorHeartbeat,
  cacheVisitorSession,
}));
jest.unstable_mockModule('@/lib/utils/request-info-extractor', () => ({
  detectScreenSize: () => 'desktop',
  extractRequestInfoWithLocation: async (request: Request) => ({
    userAgent: 'Safari', device: { type: 'desktop', os: { name: 'macOS' } },
    browser: { name: 'Safari' }, location: {}, referrer: request.headers.get('referer'),
  }),
}));

const { POST, PUT } = await import('../route');
const originalSecret = process.env.VISITOR_SESSION_TOKEN_SECRET;

beforeAll(() => { process.env.VISITOR_SESSION_TOKEN_SECRET = 'session-attribution-test-secret'; });
afterAll(() => {
  if (originalSecret === undefined) delete process.env.VISITOR_SESSION_TOKEN_SECRET;
  else process.env.VISITOR_SESSION_TOKEN_SECRET = originalSecret;
});
beforeEach(() => {
  jest.clearAllMocks();
  sessions.length = 0;
  visitors.length = 0;
  writes.length = 0;
  rpc.mockImplementation(async (name, input) => {
    if (name !== 'increment_visitor_sessions') throw new Error(`Unexpected RPC: ${name}`);
    const visitor = visitors.find(row => row.id === input.visitor_id);
    visitor.total_sessions += 1;
    visitor.last_seen_at = input.last_seen_timestamp;
    return { error: null };
  });
});

function request(body: unknown, token?: string, method = 'POST'): NextRequest {
  return new NextRequest('https://backend.makinari.com/api/visitors/session?utm_source=api-query', {
    method,
    headers: {
      'content-type': 'application/json',
      origin: 'https://www.makinari.com',
      referer: 'https://www.makinari.com/tracked-page?utm_source=http-header',
      ...(token ? { 'X-Visitor-Session-Token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function createSession(body: Record<string, unknown> = {}, token?: string) {
  const response = await POST(request({ site_id: siteId, ...body }, token));
  expect(response.status).toBe(201);
  return (await response.json()).data;
}

function firstTouch(utm: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(utm).map(([key, value]) => [`first_${key}`, value]));
}

it('captures all five URL-only UTMs identically on the new session and visitor first touch', async () => {
  await createSession({ url: landingUrl, referrer: 'https://search.example/' });
  expect(sessions[0]).toMatchObject({
    ...attribution, landing_url: landingUrl, current_url: landingUrl, referrer: 'https://search.example/',
  });
  expect(visitors[0]).toMatchObject({
    ...firstTouch(attribution), first_url: landingUrl, first_referrer: 'https://search.example/',
  });
});

it('preserves explicit nonblank UTMs verbatim ahead of conflicting URL parameters', async () => {
  const explicit = {
    utm_source: ' Explicit Source ', utm_medium: 'Email', utm_campaign: 'Newsletter',
    utm_term: '0', utm_content: 'Already%20Decoded',
  };
  await createSession({ url: landingUrl, ...explicit });
  expect(sessions[0]).toMatchObject(explicit);
  expect(visitors[0]).toMatchObject(firstTouch(explicit));
});

it.each(['', ' \t ', undefined])('falls back per field for blank/absent explicit UTMs (%p)', async blank => {
  await createSession({
    url: landingUrl, utm_source: 'explicit', utm_medium: blank, utm_campaign: blank,
    utm_term: blank, utm_content: blank,
  });
  const expected = { ...attribution, utm_source: 'explicit' };
  expect(sessions[0]).toMatchObject(expected);
  expect(visitors[0]).toMatchObject(firstTouch(expected));
});

it('ignores empty, unsafe, malformed UTF-8 and overlong URL UTM values without losing valid fields', async () => {
  await createSession({
    url: 'https://www.makinari.com/?utm_source=%00bad&utm_medium=cpc&utm_campaign=%20%20'
      + `&utm_term=${'x'.repeat(513)}&utm_content=%E0%A4`,
  });
  const expected = { ...emptyAttribution, utm_medium: 'cpc' };
  expect(sessions[0]).toMatchObject(expected);
  expect(visitors[0]).toMatchObject(firstTouch(expected));
});

it('stores null UTMs on both records when explicit and URL values are blank or missing', async () => {
  await createSession({
    url: 'https://www.makinari.com/?utm_source=&utm_medium=%20&utm_campaign=+',
    utm_source: ' ', utm_medium: '', utm_campaign: '\t', utm_term: '', utm_content: '  ',
  });
  expect(sessions[0]).toMatchObject(emptyAttribution);
  expect(visitors[0]).toMatchObject(firstTouch(emptyAttribution));
});

it.each(Object.keys(attribution))('keeps the 512-character explicit input limit for %s', async field => {
  const value = 'x'.repeat(512);
  await createSession({ url: landingUrl, [field]: value });
  expect(sessions[0][field]).toBe(value);
  expect(visitors[0][`first_${field}`]).toBe(value);
  writes.length = 0;
  expect((await POST(request({ site_id: siteId, url: landingUrl, [field]: `${value}x` }))).status).toBe(400);
  expect(writes).toHaveLength(0);
});

it.each([undefined, '', 'https://document-referrer.example/?utm_source=referrer-query'])(
  'uses only the supplied document referrer (%p), never the HTTP Referer or API URL for attribution',
  async referrer => {
    await createSession({ referrer });
    expect(sessions[0]).toMatchObject({ ...emptyAttribution, referrer: referrer || null });
    expect(visitors[0]).toMatchObject({ ...firstTouch(emptyAttribution), first_referrer: referrer || null });
  },
);

it('keeps custom_data unchanged and does not promote other query parameters or click IDs', async () => {
  const customData = { source: 'script', nested: { campaign: 'existing' } };
  await createSession({
    url: `${landingUrl}&gclid=click-id&email=private%40example.com&unknown=value`, custom_data: customData,
  });
  expect(sessions[0]).toMatchObject(attribution);
  expect(sessions[0].custom_data).toEqual(customData);
  expect(sessions[0]).not.toHaveProperty('gclid');
  expect(sessions[0]).not.toHaveProperty('email');
});

it.each(['', 'not a URL', 'https://[invalid'])('keeps existing request validation for invalid landing URL %p', async url => {
  expect((await POST(request({ site_id: siteId, url }))).status).toBe(400);
  expect(writes).toHaveLength(0);
});

it.each([
  ['POST', landingUrl], ['PUT', landingUrl],
  ['POST', 'https://www.makinari.com/'], ['PUT', 'https://www.makinari.com/'],
])('does not overwrite or backfill first touch on a %s heartbeat for %s', async (method, url) => {
  const created = await createSession({ url, referrer: 'https://document-referrer.example/' });
  const originalSession = { ...sessions[0] };
  const originalVisitor = { ...visitors[0] };
  const currentUrl = 'https://www.makinari.com/later?utm_source=later&utm_campaign=other';
  writes.length = 0;

  const response = await (method === 'POST' ? POST : PUT)(request({
    session_id: created.session_id, site_id: siteId,
    url: currentUrl, current_url: currentUrl, landing_url: currentUrl,
    ...Object.fromEntries(Object.keys(attribution).map(key => [key, 'heartbeat'])),
    referrer: 'https://later-referrer.example/', last_activity_at: Date.now(), page_views: 2,
  }, created.session_token, method));

  expect(response.status).toBe(200);
  expect(sessions).toHaveLength(1);
  expect(visitors).toEqual([originalVisitor]);
  expect(sessions[0]).toMatchObject({ ...originalSession, current_url: currentUrl, page_views: 2,
    last_activity_at: expect.any(Number) });
  expect(writes).toHaveLength(1);
  expect(writes[0].table).toBe('visitor_sessions');
  for (const key of ['landing_url', 'referrer', ...Object.keys(attribution)]) {
    expect(writes[0].data).not.toHaveProperty(key);
    expect(recordVisitorHeartbeat.mock.calls[0][2]).not.toHaveProperty(key);
    expect(cacheVisitorSession.mock.calls.at(-1)[2][key]).toEqual(originalSession[key]);
  }
  expect(rpc).not.toHaveBeenCalled();
});

it.each([
  ['attributed', landingUrl, 'https://www.makinari.com/?utm_source=next', false],
  ['direct', 'https://www.makinari.com/', landingUrl, false],
  ['no last-non-direct carryover', landingUrl, 'https://www.makinari.com/', false],
  ['counter RPC fallback', landingUrl, 'https://www.makinari.com/?utm_source=next', true],
])('preserves returning visitor first touch (%s)', async (_label, firstUrl, nextUrl, failRpc) => {
  const created = await createSession({ url: firstUrl, referrer: 'https://first-referrer.example/' });
  const originalVisitor = { ...visitors[0] };
  const originalSession = { ...sessions[0] };
  if (failRpc) rpc.mockResolvedValueOnce({ error: { message: 'RPC unavailable' } });
  const next = await createSession({
    id: created.visitor_id, previous_session_id: created.session_id,
    url: nextUrl, referrer: 'https://next-referrer.example/',
  }, created.session_token);

  expect(next.visitor_id).toBe(created.visitor_id);
  expect(visitors).toHaveLength(1);
  expect(visitors[0]).toEqual({ ...originalVisitor, total_sessions: 2, last_seen_at: expect.any(Number) });
  expect(sessions).toHaveLength(2);
  expect(sessions[1]).toMatchObject({
    previous_session_id: created.session_id,
    ...Object.fromEntries(Object.keys(attribution).map(key => [key, new URL(nextUrl).searchParams.get(key)])),
    referrer: 'https://next-referrer.example/',
  });
  for (const key of ['landing_url', 'referrer', ...Object.keys(attribution)]) {
    expect(sessions[0][key]).toEqual(originalSession[key]);
  }
  expect(rpc).toHaveBeenCalledTimes(1);
});