/** @jest-environment node */
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), channel: jest.fn() } }));
jest.mock('@/lib/security/authorize-visitor-session', () => ({ authorizeVisitorSession: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/security/request-rate-limit', () => ({
  hasAuthenticatedPrincipal: (request: Request) => request.headers.get('x-test-service') === 'yes',
}));

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { authorizeVisitorSession } from '@/lib/security/authorize-visitor-session';
import { GET, POST } from '../route';
import { database, deferred, flush, ids } from './fixtures';

let fixture: ReturnType<typeof database>;
function request(conversation: string | null = ids.private, options: ConstructorParameters<typeof NextRequest>[1] = {}) {
  const query = new URLSearchParams({ site_id: ids.site, visitor_id: ids.visitor, session_id: ids.session });
  if (conversation) query.set('conversation_id', conversation);
  return new NextRequest(`http://localhost/api/agents/chat/websocket?${query}`, options);
}
async function firstFrame(response: Response) {
  const reader = response.body!.getReader();
  const first = await reader.read();
  return { reader, text: new TextDecoder().decode(first.value) };
}

beforeEach(() => {
  jest.useFakeTimers();
  fixture = database();
  (supabaseAdmin.from as jest.Mock).mockImplementation(fixture.db.from);
  (supabaseAdmin.channel as jest.Mock).mockImplementation(fixture.db.channel);
  (authorizeVisitorSession as jest.Mock).mockResolvedValue(true);
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

it('anonymous remembered visitor cannot select old lead history when conversation_id is omitted', async () => {
  fixture.logout();
  const response = await GET(request(null));
  expect(response.status).toBe(200);
  const { reader, text } = await firstFrame(response);
  expect(text).toContain('Anonymous history');
  expect(text).not.toContain('OLD ACCOUNT');
  expect(fixture.state.queries.some(query => query.table === 'conversations'
    && query.filters.some(([key, value]) => key === 'lead_id' && value === null))).toBe(true);
  await reader.cancel();
});

it('rejects explicit lead conversation after logout', async () => {
  fixture.logout();
  expect((await GET(request())).status).toBe(403);
  expect(fixture.state.queries.some(query => query.table === 'messages')).toBe(false);
});

it.each(['logout', 'revoke', 'expiry', 'inactive', 'switch', 'same-lead-relogin', 'database', 'credential'])(
  'closes existing SSE before the next message after %s', async change => {
    const { reader, text } = await firstFrame(await GET(request()));
    expect(text).toContain('OLD ACCOUNT PRIVATE HISTORY');
    await flush();
    const channel = fixture.state.channels[0];
    expect(channel).toBeDefined();
    if (change === 'logout') fixture.logout();
    if (change === 'revoke') fixture.state.grant.revoked_at = new Date().toISOString();
    if (change === 'expiry') fixture.state.grant.expires_at = new Date(Date.now() - 1).toISOString();
    if (change === 'inactive') fixture.state.session.is_active = false;
    if (change === 'switch') { fixture.state.session.lead_id = ids.other; fixture.state.grant.lead_id = ids.other; }
    if (change === 'same-lead-relogin') {
      fixture.logout(); fixture.state.session.lead_id = ids.lead; fixture.state.grant.revoked_at = null;
      fixture.state.grant.granted_at = new Date().toISOString();
    }
    if (change === 'database') fixture.state.failedTable = 'visitor_session_identity_grants';
    if (change === 'credential') (authorizeVisitorSession as jest.Mock).mockResolvedValue(false);
    channel.event({ new: { content: 'MUST NOT LEAK' } });
    expect((await reader.read()).done).toBe(true);
    expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
  },
);

it('rechecks after pending initial history and does not install a subscription on revocation', async () => {
  const gate = deferred<void>();
  fixture.state.historyHook = () => gate.promise;
  const response = await GET(request());
  await flush();
  fixture.logout();
  gate.resolve();
  expect((await response.body!.getReader().read()).done).toBe(true);
  expect(fixture.state.channels).toHaveLength(0);
});

it.each(['cancel', 'abort'])('suppresses pending initial history after %s', async action => {
  const gate = deferred<void>();
  fixture.state.historyHook = () => gate.promise;
  const abort = new AbortController();
  const response = await GET(request(ids.private, { signal: abort.signal }));
  const reader = response.body!.getReader();
  await flush();
  if (action === 'cancel') await reader.cancel(); else abort.abort();
  gate.resolve();
  await flush();
  expect((await reader.read()).done).toBe(true);
  expect(fixture.state.channels).toHaveLength(0);
  expect(jest.getTimerCount()).toBe(0);
});

it('revalidates idle streams on heartbeat', async () => {
  const { reader } = await firstFrame(await GET(request()));
  await flush(); fixture.logout();
  jest.advanceTimersByTime(30_000);
  expect((await reader.read()).done).toBe(true);
});

it('retains service site access without requiring a browser session, rejecting cross-site conversations', async () => {
  const previousServiceKey = process.env.SERVICE_API_KEY;
  process.env.SERVICE_API_KEY = 'test-realtime-service-key';
  const service = new NextRequest(`http://localhost/api/agents/chat/websocket?site_id=${ids.site}&visitor_id=${ids.visitor}&conversation_id=${ids.private}`, {
    headers: { 'x-test-service': 'yes', 'x-api-key': process.env.SERVICE_API_KEY },
  });
  try {
    const response = await GET(service);
    expect(response.status).toBe(200);
    const { reader, text } = await firstFrame(response);
    expect(text).toContain('OLD ACCOUNT PRIVATE HISTORY');
    await reader.cancel();
    fixture.state.conversations[0].site_id = ids.other;
    expect((await GET(service)).status).toBe(403);
  } finally {
    if (previousServiceKey === undefined) delete process.env.SERVICE_API_KEY;
    else process.env.SERVICE_API_KEY = previousServiceKey;
  }
});

it('POST ignores forged lead ids and uses only anonymous history after logout', async () => {
  fixture.logout();
  const response = await POST(request(null, { method: 'POST', body: JSON.stringify({
    site_id: ids.site, session_id: ids.session, lead_id: ids.lead, visitor_id: ids.other,
  }) }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data.visitor_id).toBe(ids.visitor);
  expect(body.data.conversation_id).toBe(ids.anonymous);
  expect(JSON.stringify(body)).not.toContain('OLD ACCOUNT');
});

it('POST revalidates after pending history, without returning stale messages', async () => {
  fixture.state.historyHook = () => { fixture.logout(); };
  const response = await POST(request(ids.private, { method: 'POST', body: JSON.stringify({ content: 'Hello' }) }));
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('OLD ACCOUNT');
});