/** @jest-environment node */
import { EventEmitter } from 'node:events';
import { database, deferred, flush, ids } from './fixtures';
const { authorizeConnection } = require('../../../../../../../wsServerAuthorization.cjs');
const { handleConnection } = require('../../../../../../../wsServerConnection.cjs');

class Socket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = jest.fn();
  close = jest.fn(() => { this.readyState = 3; this.emit('close'); });
  frames() { return this.send.mock.calls.map(([frame]) => JSON.parse(frame)); }
}

let fixture: ReturnType<typeof database>;
let params: any;
let ws: Socket;
let connections: Map<any, any>;
beforeEach(() => {
  jest.useFakeTimers();
  fixture = database();
  params = {
    site_id: ids.site, session_id: ids.session, conversation_id: ids.private,
    claims: { siteId: ids.site, sessionId: ids.session, visitorId: ids.visitor, expiresAt: Date.now() + 60_000 },
  };
  ws = new Socket();
  connections = new Map();
});
afterEach(() => { ws.close(); jest.clearAllTimers(); jest.useRealTimers(); });

it('denies remembered visitor ownership for a lead conversation after logout', async () => {
  fixture.logout();
  expect(await authorizeConnection(fixture.db, params)).toMatchObject({ ok: false, code: 'CONVERSATION_FORBIDDEN' });
  params.conversation_id = ids.anonymous;
  expect(await authorizeConnection(fixture.db, params)).toMatchObject({ ok: true, lead_id: null });
});

it('does not treat a leftover active grant as identity when session lead is null', async () => {
  fixture.state.session.lead_id = null;
  expect(await authorizeConnection(fixture.db, params)).toMatchObject({ ok: false });
});

it('checks token visitor binding and fails closed offline', async () => {
  params.claims.visitorId = ids.other;
  expect(await authorizeConnection(fixture.db, params)).toMatchObject({ ok: false });
  expect(await authorizeConnection(null, params)).toMatchObject({ ok: false, code: 'REALTIME_AUTH_UNAVAILABLE' });
});

it.each(['logout', 'revoke', 'expiry', 'inactive', 'switch', 'same-lead-relogin', 'database', 'credential'])(
  'closes an existing socket before history/events after %s', async change => {
    await handleConnection(ws, params, fixture.db, connections);
    expect(ws.frames().some(frame => frame.type === 'message_history')).toBe(true);
    ws.send.mockClear();
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
    if (change === 'credential') params.claims.expiresAt = Date.now() - 1;
    fixture.state.channels[0].event({ new: { content: 'MUST NOT LEAK' } });
    ws.emit('message', JSON.stringify({ type: 'get_messages' }));
    await flush();
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
    expect(connections.size).toBe(0);
    expect(fixture.state.channels[0].unsubscribe).toHaveBeenCalledTimes(1);
  },
);

it('suppresses initial history when logout occurs during its read', async () => {
  const gate = deferred<void>();
  fixture.state.historyHook = () => gate.promise;
  const startup = handleConnection(ws, params, fixture.db, connections);
  await flush();
  fixture.logout(); gate.resolve(); await startup;
  expect(ws.frames().some(frame => frame.type === 'message_history')).toBe(false);
  expect(ws.close).toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('revalidates grants after a pending conversation authorization lookup', async () => {
  await handleConnection(ws, params, fixture.db, connections);
  ws.send.mockClear();
  fixture.state.resultHook = table => { if (table === 'conversations') fixture.logout(); };
  fixture.state.channels[0].event({ new: { content: 'MUST NOT LEAK' } });
  await flush();
  expect(ws.send).not.toHaveBeenCalled();
  expect(ws.close).toHaveBeenCalled();
});

it('installs close cleanup before startup authorization completes', async () => {
  const gate = deferred<void>();
  const original = fixture.db.from;
  let first = true;
  fixture.db.from = jest.fn((table: string) => {
    const query = original(table);
    if (first) {
      first = false;
      const then = query.then;
      query.then = (resolve: any, reject: any) => gate.promise.then(() => then(resolve, reject));
    }
    return query;
  });
  const startup = handleConnection(ws, params, fixture.db, connections);
  ws.close(); gate.resolve(); await startup;
  expect(ws.send).not.toHaveBeenCalled();
  expect(fixture.state.channels).toHaveLength(0);
  expect(connections.size).toBe(0);
});

it('does not resume an in-flight history request after a socket closes', async () => {
  await handleConnection(ws, params, fixture.db, connections);
  ws.send.mockClear();
  const gate = deferred<void>();
  fixture.state.historyHook = () => gate.promise;
  ws.emit('message', JSON.stringify({ type: 'get_messages' }));
  await flush(); ws.close(); gate.resolve(); await flush();
  expect(ws.send).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('retains live event, requested history, subscription and message acknowledgement formats', async () => {
  await handleConnection(ws, params, fixture.db, connections);
  fixture.state.channels[0].event({ new: { id: 'new-message' } });
  ws.emit('message', JSON.stringify({ type: 'get_messages', limit: 10 }));
  ws.emit('message', JSON.stringify({ type: 'subscribe', payload: { conversation_id: ids.private } }));
  ws.emit('message', JSON.stringify({ type: 'message', payload: { conversation_id: ids.private, content: 'Hello', id: 'client-1' } }));
  await flush();
  const frames = ws.frames();
  expect(frames).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'new_message', payload: { id: 'new-message' } }),
    expect.objectContaining({ type: 'message_history', data: expect.any(Array) }),
    expect.objectContaining({ type: 'subscription_ack' }),
    expect.objectContaining({ type: 'message_sent', payload: expect.objectContaining({ client_message_id: 'client-1' }) }),
  ]));
  // The delayed local acknowledgement must not write after logout.
  fixture.logout();
  jest.advanceTimersByTime(2000); await flush();
  expect(fixture.state.inserts.filter(insert => insert.table === 'messages')).toHaveLength(1);
});

it('forbids switching conversations and rejects post-logout writes', async () => {
  await handleConnection(ws, params, fixture.db, connections);
  ws.emit('message', JSON.stringify({ type: 'subscribe', payload: { conversation_id: ids.other } }));
  await flush();
  expect(ws.frames()).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'error', payload: expect.objectContaining({ code: 'CONVERSATION_FORBIDDEN' }) }),
  ]));
  fixture.logout();
  ws.emit('message', JSON.stringify({ type: 'message', payload: { conversation_id: ids.private, content: 'forbidden' } }));
  await flush();
  expect(fixture.state.inserts).toHaveLength(0);
});

it('revalidates idle sockets on heartbeat and isolates cleanup for shared visitors', async () => {
  const otherSocket = new Socket();
  await handleConnection(ws, params, fixture.db, connections);
  await handleConnection(otherSocket, params, fixture.db, connections);
  ws.close();
  expect(connections.size).toBe(1);
  expect(fixture.state.channels[1].unsubscribe).not.toHaveBeenCalled();
  otherSocket.send.mockClear(); fixture.logout();
  jest.advanceTimersByTime(30_000); await flush();
  expect(otherSocket.send).not.toHaveBeenCalled();
  expect(otherSocket.close).toHaveBeenCalled();
  expect(connections.size).toBe(0);
});