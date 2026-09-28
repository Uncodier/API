// @ts-nocheck -- Dynamic ESM Jest mocks under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const siteId = '9be0a6a2-5567-41bf-ad06-cb4014f0faf2';
const sessions: Record<string, any>[] = [];
const inserts: Record<string, any>[] = [];
const updates: Record<string, any>[] = [];
const originBelongsToSite = jest.fn(async (request: Request, id: string) =>
  request.headers.get('origin') === 'https://www.makinari.com' && id === siteId);
const enforceRequestRateLimit = jest.fn(async () => null);

const from = jest.fn((table: string) => {
  const filters: Record<string, unknown> = {};
  let inserted: Record<string, any> | null = null;
  let updated: Record<string, any> | null = null;
  const matchingSession = () => sessions.find(session =>
    Object.entries(filters).every(([key, value]) => session[key] === value)) || null;
  const query: any = {
    select: () => query,
    eq: (key: string, value: unknown) => { filters[key] = value; return query; },
    order: () => query,
    limit: () => query,
    insert: (rows: Record<string, any>[]) => {
      inserted = rows[0];
      if (table === 'visitors') return Promise.resolve({ error: null });
      inserts.push(inserted);
      sessions.push({ ...inserted, lead_id: null });
      return query;
    },
    update: (values: Record<string, any>) => { updated = values; return query; },
    maybeSingle: async () => {
      if (table === 'visitors') return { data: null, error: null };
      const session = matchingSession();
      if (updated && session) {
        Object.assign(session, updated);
        updates.push(updated);
        return { data: { id: session.id }, error: null };
      }
      return { data: session, error: null };
    },
    single: async () => ({ data: inserted || matchingSession(), error: null }),
  };
  return query;
});

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit, hasAuthenticatedPrincipal: () => false,
}));
jest.unstable_mockModule('@/lib/security/site-access', () => ({
  canAccessSite: async () => false, originBelongsToSite,
}));
jest.unstable_mockModule('@/lib/services/visitor-session-live-state', () => ({
  closeVisitorLiveState: async () => undefined,
  readCachedVisitorSession: async () => null,
  readVisitorHeartbeat: async () => ({}),
  recordVisitorHeartbeat: async () => null,
  cacheVisitorSession: async () => undefined,
}));
jest.unstable_mockModule('@/lib/utils/request-info-extractor', () => ({
  detectScreenSize: () => 'desktop',
  extractRequestInfoWithLocation: async () => ({
    userAgent: 'Safari', device: { type: 'desktop', os: { name: 'macOS' } },
    browser: { name: 'Safari' }, location: {},
  }),
}));

const { POST } = await import('../route');
const { PUT } = await import('../read-update-session');
const { issueVisitorSessionToken } = await import('@/lib/security/visitor-session-token');
const originalSecret = process.env.VISITOR_SESSION_TOKEN_SECRET;

beforeAll(() => { process.env.VISITOR_SESSION_TOKEN_SECRET = 'script-post-compatibility-test-secret'; });
afterAll(() => {
  if (originalSecret === undefined) delete process.env.VISITOR_SESSION_TOKEN_SECRET;
  else process.env.VISITOR_SESSION_TOKEN_SECRET = originalSecret;
});
beforeEach(() => {
  jest.clearAllMocks();
  sessions.length = 0;
  inserts.length = 0;
  updates.length = 0;
});

function request(body: unknown, token?: string, method = 'POST', origin = 'https://www.makinari.com'): NextRequest {
  return new NextRequest('https://backend.makinari.com/api/visitors/session', {
    method,
    headers: {
      'content-type': 'application/json',
      origin,
      ...(token ? { 'X-Visitor-Session-Token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function createSession() {
  const response = await POST(request({
    site_id: siteId, url: 'https://www.makinari.com/', timestamp: Date.now(),
  }));
  expect(response.status).toBe(201);
  const json = await response.json();
  expect(json).toMatchObject({
    success: true,
    data: {
      session_id: expect.any(String), visitor_id: expect.any(String),
      session_token: expect.any(String), expires_at: expect.any(Number),
    },
  });
  return json.data;
}

it('creates the Script session with authenticated response fields and site-bound origin', async () => {
  await createSession();
  expect(originBelongsToSite).toHaveBeenCalledWith(expect.any(NextRequest), siteId);
  expect(inserts).toHaveLength(1);
});

it('maps the Script device_data/custom_data fields without trusting claimed identity fields', async () => {
  const response = await POST(request({
    site_id: siteId, url: 'https://www.makinari.com/',
    device_data: {
      screenWidth: 1440, screenHeight: 900, pixelRatio: 2,
      browser: 'Safari', browserVersion: '18', desktop: true,
    },
    custom_data: { campaign: 'launch' }, leadId: 'forged-lead',
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }));
  expect(response.status).toBe(201);
  expect(inserts[0]).toMatchObject({
    device: { type: 'desktop', screen_size: '1440x900', pixel_ratio: 2 },
    browser: { name: 'Safari', version: '18' },
    custom_data: { campaign: 'launch' },
  });
  expect(inserts[0]).not.toHaveProperty('lead_id');
  expect(inserts[0].id).not.toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

it('rejects a forged URL when the actual Origin does not belong to the site', async () => {
  const response = await POST(request({ site_id: siteId, url: 'https://www.makinari.com/' },
    undefined, 'POST', 'https://untrusted.example'));
  expect(response.status).toBe(403);
  expect(inserts).toHaveLength(0);
});

it('treats the Script session POST as a signed update, not a new visitor or session', async () => {
  const created = await createSession();
  const response = await POST(request({
    session_id: created.session_id,
    site_id: siteId,
    visitor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    lead_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    url: 'https://www.makinari.com/pricing',
    last_activity_at: Date.now(),
    duration: 1000,
    device_data: { browser: 'Safari' },
    custom_data: { source: 'script' },
  }, created.session_token));
  expect(response.status).toBe(200);
  const json = await response.json();
  expect(json).toMatchObject({ success: true, data: {
    session_id: created.session_id,
    visitor_id: created.visitor_id,
    site_id: siteId,
    lead_id: null,
    session_token: expect.any(String),
    expires_at: expect.any(Number),
  } });
  expect(inserts).toHaveLength(1);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    current_url: 'https://www.makinari.com/pricing',
    custom_data: { source: 'script' },
  });
  expect(updates[0]).not.toHaveProperty('visitor_id');
  expect(updates[0]).not.toHaveProperty('lead_id');
  expect(originBelongsToSite).toHaveBeenCalledTimes(1);
});

it('rejects POST updates without a valid token, even from an allowed origin', async () => {
  const created = await createSession();
  const otherToken = await issueVisitorSessionToken({
    siteId, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', visitorId: created.visitor_id,
  });
  const otherSiteToken = await issueVisitorSessionToken({
    siteId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sessionId: created.session_id, visitorId: created.visitor_id,
  });
  const expiredToken = await issueVisitorSessionToken({
    siteId, sessionId: created.session_id, visitorId: created.visitor_id,
  }, -10);
  for (const token of [undefined, 'invalid', otherToken, otherSiteToken, expiredToken]) {
    const response = await POST(request({ session_id: created.session_id, site_id: siteId }, token));
    expect(response.status).toBe(403);
  }
  expect(inserts).toHaveLength(1);
  expect(updates).toHaveLength(0);
});

it('never falls back to creating a session when session_id is malformed or inactive', async () => {
  const created = await createSession();
  expect((await POST(request({ session_id: 'bad-id', site_id: siteId }))).status).toBe(400);
  expect((await POST(request({ session_id: null, site_id: siteId }))).status).toBe(400);
  sessions[0].is_active = false;
  expect((await POST(request({ session_id: created.session_id, site_id: siteId }, created.session_token))).status).toBe(404);
  expect(inserts).toHaveLength(1);
  expect(updates).toHaveLength(0);
});

it('keeps the PUT update contract and returns a renewed session token', async () => {
  const created = await createSession();
  const response = await PUT(request({
    site_id: siteId, session_id: created.session_id, current_url: 'https://www.makinari.com/contact',
  }, created.session_token, 'PUT'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: {
    session_id: created.session_id, visitor_id: created.visitor_id,
    site_id: siteId, session_token: expect.any(String),
  } });
  expect(inserts).toHaveLength(1);
});