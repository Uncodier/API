import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { POST as neutral } from '../route';
import { POST as callback } from '@/app/api/integrations/zavu/webhook/route';
import { freshPostgres } from '@/lib/procurement/__tests__/fixtures/workflow-postgres';
import { inboundDatabase, SITE, OTHER_SITE } from '@/lib/services/zavu/__tests__/inbound-lead-test-database';
import { zavuInboundBindingHash } from '@/lib/services/zavu/inbound-claim';

// Real signed routes, settings selection, claim helper, migrations and token-fenced
// finish. Only the transport to this socket-only DB and external work are replaced.
const mockFrom = jest.fn(), mockRpc = jest.fn(), mockAdmit = jest.fn(), mockRecover = jest.fn(), mockLicense = jest.fn();
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { from: (...a: unknown[]) => mockFrom(...a) } }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => mockRpc(...a) } }));
jest.mock('@/lib/services/channels/admit-message', () => ({ admitChannelMessage: (...a: unknown[]) => mockAdmit(...a),
  reconcileChannelMessage: (...a: unknown[]) => mockRecover(...a) }));
jest.mock('@/lib/services/zavu/inbound-message-license', () => ({ admitZavuInboundAutomation: (...a: unknown[]) => mockLicense(...a) }));
jest.mock('@/lib/security/upstash-rest', () => ({ sha256: jest.requireActual('@/lib/security/upstash-rest').sha256, setCachedJson: jest.fn() }));
jest.mock('@/lib/services/zavu/inbound-audio-media', () => ({ resolveInboundAudioMedia: async () => ({ attachments: [] }) }));
jest.mock('@/lib/services/zavu/inbound-message-history', () => ({}));
jest.mock('@/lib/services/zavu/voice-webhook-handler', () => ({}));
jest.mock('@/lib/services/zavu/invitation-finalization', () => ({}));
jest.mock('@/lib/services/zavu/domain-status', () => ({}));
jest.mock('@/lib/services/zavu/whatsapp-app-echo', () => ({ isWhatsAppAppEcho: () => false }));
jest.mock('@/lib/services/zavu/template-delivery-events', () => ({ reconcileTemplateDeliveryEvent: jest.fn() }));
jest.mock('@/lib/services/zavu/audio-delivery-events', () => ({ reconcileAudioDeliveryEvent: jest.fn() }));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: (value: string) => value }));

let db: ReturnType<typeof freshPostgres>;
const addr = 'telegram:contact', project = randomBytes(32).toString('hex'), oldSecret = process.env.ZAVUDEV_WEBHOOK_SECRET;
const other = randomBytes(32).toString('hex');
const conn = (sender: string, channel = 'telegram', id = `connection-${sender}-${channel}`) =>
  ({ id, type: channel, zavu_sender_id: sender, metadata: { zavu_webhook_secret: other } });
const site = (id: string, ...connections: ReturnType<typeof conn>[]) => ({ site_id: id, channels: { connections } });
const settings = (...rows: ReturnType<typeof site>[]) => inboundDatabase(mockFrom, { settings: rows });
const payload = (senderId = 'one', messageId: string | undefined = 'shared', channel = 'telegram') => ({ type: 'message.inbound', senderId,
  site_id: 'untrusted', connection_id: 'untrusted', data: { channel, from: addr, text: 'Hi', messageId } });
function withoutMessageId(event: ReturnType<typeof payload>) {
  const {messageId: _omitted, ...rest} = event.data;
  return {...event,data:rest};
}
const send = (handler: typeof neutral, event: object, secret = project) => {
  const body = JSON.stringify(event), timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const path = handler === neutral ? '/api/agent/message' : '/api/integrations/zavu/webhook';
  return handler(new Request(`https://api.example.test${path}`, { method: 'POST', body,
    headers: { 'x-zavu-signature': `t=${timestamp},v2=${digest}` } }));
};

const lit = (value: unknown) => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
function localRpc(name: string, params: Record<string, unknown>) {
  if (![name, ...Object.keys(params)].every(s => /^[a-z_]+$/.test(s))) throw new Error('Unexpected RPC identifier');
  const args = Object.entries(params).map(([k,v]) => `${k} => ${lit(v)}`).join(',');
  const result = db.result(`SET ROLE service_role; SELECT to_json(public.${name}(${args}));`);
  return result.status === 0 ? { data: JSON.parse(result.stdout.trim().split('\n').pop()!), error: null }
    : { data: null, error: { message: result.stderr } };
}
const history = ['bare', 'prefixed'].flatMap(format => ['completed', 'busy', 'failed', 'expired', 'unknown'].map(state => {
  const message = `historical-${format}-${state}`;
  return { format, state, message, key: format === 'bare' ? message : `message.inbound:${message}` };
}));
const snapshot = (key: string) => db.query(`SELECT to_jsonb(e) FROM private.provider_webhook_events e
  WHERE provider = 'zavu' AND event_id = ${lit(key)}`);
function seedUnbound(key: string, state: string, type = 'message.inbound') {
  const status = ['completed', 'failed'].includes(state) ? state : 'processing';
  const expiry = state === 'busy' ? "now() + interval '5 minutes'" : state === 'expired' ? "now() - interval '5 minutes'" : 'NULL';
  db.query(`INSERT INTO private.provider_webhook_events (provider,event_type,event_id,status,attempt_count,
    claimed_at,claim_token,claim_expires_at,last_error) VALUES ('zavu',${lit(type)},${lit(key)},${lit(status)},3,
    now(),${lit(randomUUID())},${expiry},'saved evidence')`);
}
beforeAll(() => {
  db = freshPostgres();
  db.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE public.payments(transaction_id text);');
  db.migrate('20260920005000_add_provider_webhook_event_claims.sql');
  db.migrate('20260920007000_fix_provider_webhook_claims.sql');
  for (const { key, state } of history) seedUnbound(key, state);
  for (const state of ['completed','busy','failed','expired']) seedUnbound(`explicit-${state}`,state);
  seedUnbound('ambiguous-origin','failed','message.sent');
  db.migrate('20261121001000_zavu_inbound_claim_binding.sql');
  db.migrate('20261126220000_read_zavu_inbound_binding.sql');
  process.env.ZAVUDEV_WEBHOOK_SECRET = project;
}, 60000);
beforeEach(() => {
  jest.clearAllMocks();
  settings(site(SITE, conn('one'), conn('one', 'email'), conn('two')), site(OTHER_SITE, conn('three')));
  mockRpc.mockImplementation(localRpc);
  mockLicense.mockResolvedValue(true);
});
afterAll(() => {
  db?.stop();
  if (oldSecret === undefined) delete process.env.ZAVUDEV_WEBHOOK_SECRET; else process.env.ZAVUDEV_WEBHOOK_SECRET = oldSecret;
});

test('only an exact signed Zavu WhatsApp binding is visible to the service role', async () => {
  settings(site(SITE, conn('one', 'whatsapp')));
  const from = 'whatsapp:+14155550100', messageId = 'signed-whatsapp-repair';
  const base = payload('one', messageId, 'whatsapp');
  const event = { ...base, data: { ...base.data, from } };
  const binding = { siteId: SITE, connectionId: 'connection-one-whatsapp', senderId: 'one', channel: 'whatsapp' };
  const lookup = (hash: string) => db.query(`SET ROLE service_role; SELECT public.has_signed_zavu_inbound_binding(${lit(hash)})`).split('\n').at(-1);
  const exact = zavuInboundBindingHash(binding, messageId, from);
  expect((await send(neutral, event, other + 'invalid')).status).toBe(401);
  expect(lookup(exact)).toBe('f');
  expect((await send(neutral, event)).status).toBe(200);
  expect(lookup(exact)).toBe('t');
  expect(lookup(zavuInboundBindingHash(binding, messageId, 'whatsapp:+14155550109'))).toBe('f');
  expect(lookup(zavuInboundBindingHash({ ...binding, siteId: OTHER_SITE }, messageId, from))).toBe('f');
  for (const role of ['anon', 'authenticated']) {
    expect(db.query(`SELECT has_function_privilege('${role}', 'public.has_signed_zavu_inbound_binding(text)', 'EXECUTE')`)).toBe('f');
  }
});

test('equal no-event-ID provider message IDs on distinct accounts, channels and sites are independently admitted once across both URLs', async () => {
  for (const [i, [sender, channel]] of [['one','telegram'], ['two','telegram'], ['one','email'], ['three','telegram']].entries()) {
    const event = payload(sender, 'shared', channel), secret = i % 2 ? project : other;
    expect(await (await send(i % 2 ? neutral : callback, event, secret)).text()).toBe('OK');
    expect(await (await send(i % 2 ? callback : neutral, event, secret)).json()).toEqual({ success: true, duplicate: true });
  }
  expect(mockAdmit.mock.calls.map(([msg]) => [msg.siteId, msg.connectionId, msg.source.senderId, msg.originMessageId])).toEqual([
    [SITE, 'connection-one-telegram', 'one', 'shared'], [SITE, 'connection-two-telegram', 'two', 'shared'],
    [SITE, 'connection-one-email', 'one', 'shared'], [OTHER_SITE, 'connection-three-telegram', 'three', 'shared'],
  ]);
});

test.each(history)('legacy $format $state is read-only and not attributable on either URL', async ({ message, key }) => {
  const before = snapshot(key);
  for (const handler of [neutral, callback]) {
    const response = await send(handler, payload('two', message));
    expect([response.status, await response.json()]).toEqual([409, { success: false, error: 'Inbound receipt requires reconciliation' }]);
  }
  expect(snapshot(key)).toBe(before);
  expect(mockAdmit).not.toHaveBeenCalled();
  expect(mockRecover).not.toHaveBeenCalled();
  expect(mockRpc.mock.calls.every(([name]) => name === 'claim_zavu_inbound_webhook')).toBe(true);
});

test('legacy lookup is by key regardless of event type; ambiguous lifecycle row is not changed', async () => {
  const key = 'ambiguous-origin', before = snapshot(key);
  expect((await send(neutral, payload('one', key))).status).toBe(409);
  expect(snapshot(key)).toBe(before);
  expect(mockAdmit).not.toHaveBeenCalled();
});

test.each([['completed',200],['busy',503],['failed',409],['expired',409]] as const)(
  'historical explicit ID stays in its original namespace (%s) without reopening it', async (state, status) => {
    const key = `explicit-${state}`, before = snapshot(key);
    const response = await send(callback, { ...payload(), eventId: key });
    expect(response.status).toBe(status);
    if (state === 'completed') expect(await response.json()).toEqual({ success: true, duplicate: true });
    expect(snapshot(key)).toBe(before);
    expect(mockAdmit).not.toHaveBeenCalled();
    expect(mockRecover).not.toHaveBeenCalled();
  });

test.each(['site', 'connection', 'contact'])('a re-bound %s cannot recover or re-run a prior receipt', async kind => {
  const event = payload('one', `moved-${kind}`);
  expect((await send(neutral, event)).status).toBe(200);
  if (kind === 'site') settings(site(OTHER_SITE, conn('one')));
  if (kind === 'connection') settings(site(SITE, conn('one', 'telegram', 'replacement')));
  if (kind === 'contact') event.data.from = 'unrelated';
  const response = await send(callback, event);
  expect(response.status).toBe(409);
  expect(mockAdmit).toHaveBeenCalledTimes(1);
  expect(mockRecover).not.toHaveBeenCalled();
});

test.each(['missing','duplicate connection','duplicate site','duplicate ID','inconsistent signed sender'])(
  'ambiguous source (%s) is never claimed or recovered', async kind => {
    const event = payload('one', `ambiguous-${kind}`);
    if (kind === 'missing') settings(site(SITE, conn('unrelated')));
    if (kind === 'duplicate connection') settings(site(SITE, conn('one'), conn('one', 'telegram', 'other')));
    if (kind === 'duplicate site') settings(site(SITE, conn('one')), site(OTHER_SITE, conn('one')));
    if (kind === 'duplicate ID') settings(site(SITE, conn('one'), conn('two', 'telegram', 'connection-one-telegram')));
    if (kind === 'inconsistent signed sender') Object.assign(event, {sender: {id: 'other'}});
    expect((await send(callback, event)).status).toBe(kind === 'inconsistent signed sender' ? 400 : 409);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockAdmit).not.toHaveBeenCalled();
  });

test('sender binding changing after the claim never moves work into its replacement', async () => {
  const event = payload('one','between-reads');
  const state = settings(site(SITE, conn('one')));
  mockRpc.mockImplementationOnce((name, args) => {
    const result = localRpc(name, args);
    state.tables.settings[0].channels.connections[0].id = 'moved';
    return result;
  });
  expect((await send(neutral,event,other)).status).toBe(500);
  expect((await send(callback,event,other)).status).toBe(409);
  expect(mockAdmit).not.toHaveBeenCalled();
  expect(mockRecover).not.toHaveBeenCalled();
});

test.each(['explicit','digest','fallback'])('failed bound %s receipt performs lookup only, including when retry content is unavailable', async mode => {
  const originalPayload = payload('one', `failed-${mode}`);
  const event = mode === 'digest' ? withoutMessageId(originalPayload) : originalPayload;
  if (mode === 'explicit') Object.assign(event, {id: 'v2-explicit-failure'});
  mockAdmit.mockRejectedValueOnce(new Error('Original outcome unavailable'));
  expect((await send(neutral,event)).status).toBe(500);
  const [original] = mockAdmit.mock.calls[0];
  if (mode !== 'digest') { event.data.text = ''; Object.assign(event.data, {direction: 'outbound'}); }
  expect(await (await send(callback,event)).text()).toBe('OK');
  expect(mockRecover).toHaveBeenCalledWith(expect.objectContaining({ siteId: original.siteId, channel: original.channel,
    connectionId: original.connectionId, originMessageId: original.originMessageId, source: original.source, attachments: [] }));
  expect(mockAdmit).toHaveBeenCalledTimes(1);
  expect(mockLicense).toHaveBeenCalledTimes(1);
});

test('RPC absence, unknown states and malformed retry disposition are unavailable, never generic claims', async () => {
  for (const result of [ { data: null, error: {message:'not installed'} }, { data:{state:'unknown'}, error:null },
    { data:{state:'claimed', claim_expires_at:new Date().toISOString()}, error:null } ]) {
    mockRpc.mockResolvedValueOnce(result);
    const res = await send(neutral, payload('one','malformed-rpc'));
    expect([res.status,res.headers.get('Retry-After')]).toEqual([503,'5']);
  }
  expect(mockAdmit).not.toHaveBeenCalled();
  expect(mockRecover).not.toHaveBeenCalled();
  expect(mockRpc.mock.calls.map(([n])=>n)).toEqual(Array(3).fill('claim_zavu_inbound_webhook'));
});

test('old inbound writers are fenced, old finish remains token-fenced, lifecycle and explicit ids keep their namespace', async () => {
  const claim = (id: string, type: string) => localRpc('claim_provider_webhook_event', { p_provider:'zavu',
    p_event_id:id, p_event_type:type, p_claim_token:randomUUID(), p_lease_seconds:300 });
  for (const id of ['explicit-failed', 'never-claimed', 'message.inbound:never-claimed']) {
    const before = snapshot(id);
    expect(claim(id,'message.inbound').error?.message).toMatch(/Bound Zavu inbound admission required/);
    expect(snapshot(id)).toBe(before);
  }
  expect(claim('explicit-failed','message.sent').error?.message).toMatch(/Cannot change Zavu inbound receipt identity/);
  const old = JSON.parse(snapshot('explicit-busy'));
  expect(localRpc('finish_provider_webhook_event', { p_provider:'zavu', p_event_id:'explicit-busy',
    p_claim_token:randomUUID(), p_status:'completed' }).data).toBe(false);
  expect(localRpc('finish_provider_webhook_event', { p_provider:'zavu', p_event_id:'explicit-busy',
    p_claim_token:old.claim_token, p_status:'completed' }).data).toBe(true);
  const event = payload('one','opaque-id');
  expect((await send(neutral,event)).status).toBe(200);
  const scopedId = mockRpc.mock.calls.find(([name])=>name==='claim_zavu_inbound_webhook')![1].p_event_id;
  expect(await (await send(neutral,{...payload('two','unrelated'), eventId:scopedId})).text()).toBe('OK');
  expect((await send(neutral,{...event,type:'message.sent'})).status).toBe(400);
  for (const type of ['message.sent','message.failed']) {
    expect((await send(callback,{...event,type})).status).toBe(200);
    expect(JSON.parse(snapshot(`${type}:opaque-id`))).toMatchObject({ status:'completed',event_type:type,zavu_binding_hash:null });
  }
  expect(mockAdmit).toHaveBeenCalledTimes(2);
});

test('overlapping URLs converge on a busy lease; expired claim is recovery-only and a stale owner cannot finish', async () => {
  const event = payload('one','lease-overlap');
  let begin!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => {begin = resolve;});
  const waiting = new Promise<void>(resolve => {release = resolve;});
  mockAdmit.mockImplementationOnce(async () => { begin(); await waiting; });
  const first = send(neutral,event);
  try {
    await entered;
    const busy = await send(callback,event);
    expect([busy.status, busy.headers.get('Retry-After')]).toEqual([503,'5']);
    expect(mockRecover).not.toHaveBeenCalled();
    const {p_event_id} = mockRpc.mock.calls[0][1];
    db.query(`UPDATE private.provider_webhook_events SET claim_expires_at = now() - interval '1 second'
      WHERE provider='zavu-inbound-message-v2' AND event_id=${lit(p_event_id)}`);
    expect((await send(callback,event)).status).toBe(200);
    expect(mockRecover).toHaveBeenCalledTimes(1);
  } finally { release(); }
  const stale = await first;
  expect([stale.status, stale.headers.get('Retry-After')]).toEqual([503, '5']);
  expect(await (await send(neutral,event)).json()).toEqual({success:true,duplicate:true});
  expect(mockAdmit).toHaveBeenCalledTimes(1);
});

test('the signed-body digest is byte-for-byte compatible and historical pre-binding tombstones have no granted browser access', async () => {
  const event = withoutMessageId(payload('one'));
  expect((await send(neutral,event)).status).toBe(200);
  const id = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  expect(JSON.parse(snapshot(id))).toMatchObject({ provider:'zavu', status:'completed', zavu_binding_hash:expect.any(String) });
  for (const role of ['anon','authenticated']) {
    expect(db.query(`SELECT has_function_privilege('${role}','claim_zavu_inbound_webhook(text,text,uuid,text)','EXECUTE'),
      has_table_privilege('${role}','private.provider_webhook_events','SELECT')`)).toBe('f|f');
  }
  expect(db.query(`SELECT relrowsecurity FROM pg_class WHERE oid='private.provider_webhook_events'::regclass`)).toBe('t');
  expect(db.query(`SELECT prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc
    WHERE oid='claim_zavu_inbound_webhook(text,text,uuid,text)'::regprocedure`)).toBe('t');
});

test('a shared provider sender cannot use another channel connection secret', async () => {
  const mail = conn('one','email'); const emailSecret = randomBytes(32).toString('hex');
  mail.metadata.zavu_webhook_secret = emailSecret;
  settings(site(SITE,conn('one','telegram'),mail));
  const event = payload('one','channel-signing-key','email');
  expect((await send(neutral,event,other)).status).toBe(401);
  expect((await send(callback,event,emailSecret)).status).toBe(200);
  expect(mockAdmit).toHaveBeenCalledTimes(1);
});
