/** @jest-environment node */
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: jest.fn(), channel: jest.fn(), auth: { getUser: jest.fn() } },
}));
// An intentionally stale infrastructure cache must not keep a credential alive.
jest.mock('@/lib/security/upstash-rest', () => ({
  getCachedJson: jest.fn().mockResolvedValue({ allowed: true }),
  setCachedJson: jest.fn().mockResolvedValue(true),
}));

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { GET, POST } from '../route';
import { credentialKey, credentialRow, restoreEnvironment } from './credential-fixtures';
import { database, deferred, flush, ids } from './fixtures';

let fixture: ReturnType<typeof database>;
let row: Awaited<ReturnType<typeof credentialRow>>;
const previous = { ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, SERVICE_API_KEY: process.env.SERVICE_API_KEY };

function request(headers: HeadersInit = {
  'x-api-key': credentialKey,
  'x-api-key-data': JSON.stringify({ id: 'key-1', user_id: 'user-1', site_id: ids.site, scopes: ['read'] }),
}, post = false) {
  const query = new URLSearchParams({ site_id: ids.site, visitor_id: ids.visitor, conversation_id: ids.private });
  return new NextRequest(`http://localhost/api/agents/chat/websocket?${query}`, {
    headers, ...(post ? { method: 'POST', body: JSON.stringify({ visitor_id: ids.visitor, content: 'Hello' }) } : {}),
  });
}

async function open(input = request()) {
  const response = await GET(input);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const history = await reader.read();
  expect(new TextDecoder().decode(history.value)).toContain('OLD ACCOUNT PRIVATE HISTORY');
  await flush();
  expect(fixture.state.channels).toHaveLength(1);
  return { reader, channel: fixture.state.channels[0] };
}

beforeEach(async () => {
  jest.useFakeTimers();
  process.env.ENCRYPTION_KEY = 'offline-realtime-key-encryption-secret';
  delete process.env.SERVICE_API_KEY;
  fixture = database();
  row = await credentialRow();
  fixture.state.apiKeys = [row];
  (supabaseAdmin.from as jest.Mock).mockImplementation(fixture.db.from);
  (supabaseAdmin.channel as jest.Mock).mockImplementation(fixture.db.channel);
  (supabaseAdmin.auth.getUser as jest.Mock).mockImplementation(fixture.db.auth.getUser);
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); restoreEnvironment(previous); });

it.each(['revoked', 'expired', 'scope', 'site', 'encrypted-material', 'forged-metadata'])(
  'GET rejects %s despite initially accepted principal metadata before reading history', async change => {
    if (change === 'revoked') row.status = 'revoked';
    if (change === 'expired') row.expires_at = new Date(Date.now() - 1).toISOString();
    if (change === 'scope') row.scopes = ['identity:issue'];
    if (change === 'site') row.site_id = ids.other;
    if (change === 'encrypted-material') row.key_hash = (await credentialRow('key_wrong-proof')).key_hash;
    const input = change === 'forged-metadata'
      ? request({ 'x-api-key-data': JSON.stringify({ isService: true }) }) : request();
    const response = await GET(input);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('OLD ACCOUNT');
    expect(fixture.state.queries.some(query => query.table === 'messages')).toBe(false);
    expect(fixture.state.channels).toHaveLength(0);
  },
);

it.each(['revoked', 'expired', 'scope', 'site', 'owner', 'version', 'deleted', 'storage'])(
  'reauthenticates the real API key on the next event after %s', async change => {
    const { reader, channel } = await open();
    if (change === 'revoked') row.status = 'revoked';
    if (change === 'expired') row.expires_at = new Date(Date.now() - 1).toISOString();
    if (change === 'scope') row.scopes = ['write'];
    if (change === 'site') row.site_id = ids.other;
    if (change === 'owner') row.user_id = 'other-user';
    if (change === 'version') row.identity_token_version = ids.other;
    if (change === 'deleted') fixture.state.apiKeys = [];
    if (change === 'storage') fixture.state.failedTable = 'api_keys';
    channel.event({ new: { content: 'MUST NOT LEAK' } });
    expect((await reader.read()).done).toBe(true);
    expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
  },
);

it('checks live credentials before connection-established events', async () => {
  const { reader, channel } = await open();
  row.status = 'revoked';
  channel.status('SUBSCRIBED');
  expect((await reader.read()).done).toBe(true);
});

it('expires an idle credential on the heartbeat without waiting for a database event', async () => {
  row.expires_at = new Date(Date.now() + 20_000).toISOString();
  const { reader, channel } = await open();
  jest.advanceTimersByTime(30_000);
  expect((await reader.read()).done).toBe(true);
  expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
});

it('rechecks after pending history and suppresses its delivery if the credential is revoked', async () => {
  const gate = deferred<void>();
  const historyStarted = deferred<void>();
  fixture.state.historyHook = () => { historyStarted.resolve(); return gate.promise; };
  const response = await GET(request());
  expect(response.status).toBe(200);
  await historyStarted.promise;
  row.status = 'revoked'; gate.resolve();
  expect((await response.body!.getReader().read()).done).toBe(true);
  expect(fixture.state.channels).toHaveLength(0);
});

it('rechecks before reading initial history if revocation follows GET admission', async () => {
  let conversationChecks = 0;
  fixture.state.resultHook = table => {
    if (table === 'conversations' && ++conversationChecks === 1) row.status = 'revoked';
  };
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect((await response.body!.getReader().read()).done).toBe(true);
  expect(fixture.state.queries.some(query => query.table === 'messages')).toBe(false);
});

it('reauthenticates live environment service keys on each event', async () => {
  process.env.SERVICE_API_KEY = 'realtime-service-secret';
  const { reader, channel } = await open(request({
    authorization: 'Bearer realtime-service-secret', 'x-api-key-data': JSON.stringify({ isService: true }),
  }));
  delete process.env.SERVICE_API_KEY;
  channel.event({ new: { content: 'MUST NOT LEAK' } });
  expect((await reader.read()).done).toBe(true);
});

it.each(['revoked', 'expired', 'site-transfer', 'principal-change', 'membership-revoked'])(
  'reauthenticates the real bearer and uncached site permission after %s', async change => {
    fixture.state.sites = [{ id: ids.site, user_id: 'user-1' }];
    if (change === 'membership-revoked') {
      fixture.state.sites = [];
      fixture.state.members = [{ site_id: ids.site, user_id: 'user-1', status: 'active' }];
    }
    const { reader, channel } = await open(request({
      authorization: `Bearer ${fixture.state.bearer}`, 'x-auth-validated': 'true', 'x-auth-user-id': 'user-1',
    }));
    if (change === 'revoked') fixture.state.user = null;
    if (change === 'expired') fixture.state.userExpiresAt = Date.now() - 1;
    if (change === 'site-transfer') fixture.state.sites[0].user_id = 'user-2';
    if (change === 'membership-revoked') fixture.state.members[0].status = 'inactive';
    if (change === 'principal-change') {
      fixture.state.user.id = 'user-2'; fixture.state.sites[0].user_id = 'user-2';
    }
    channel.event({ new: { content: 'MUST NOT LEAK' } });
    expect((await reader.read()).done).toBe(true);
    expect(fixture.db.auth.getUser.mock.calls.length).toBeGreaterThan(3);
  },
);

it('does not save messages when POST presents revoked credentials', async () => {
  row.status = 'revoked';
  expect((await POST(request(undefined, true))).status).toBe(403);
  expect(fixture.state.inserts).toHaveLength(0);
});

it('rechecks credentials after POST history before returning its contents', async () => {
  fixture.state.historyHook = () => { row.status = 'revoked'; };
  const response = await POST(request(undefined, true));
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('OLD ACCOUNT');
});