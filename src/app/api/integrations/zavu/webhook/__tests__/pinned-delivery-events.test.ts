import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { POST as callback } from '../route';
import { POST as inboundOnly } from '@/app/api/agent/message/route';
import { reconcilePinnedDeliveryEvent as reconcile } from '@/lib/services/zavu/pinned-delivery-events';
import { pinnedReplyPayloadHash } from '@/lib/messaging/pinned-reply-payload';
import { inboundDatabase, SITE, OTHER_SITE, type Row } from '@/lib/services/zavu/__tests__/inbound-lead-test-database';

const mockFrom = jest.fn(), mockVerifySettings = jest.fn(), mockClaim = jest.fn(), mockFinish = jest.fn();
const mockTemplate = jest.fn(), mockAudio = jest.fn(), mockInbound = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  from: (...a: unknown[]) => mockFrom(...a), schema: () => ({ from: mockFrom }),
} }));
jest.mock('@/lib/services/zavu/webhook-handlers', () => ({ findSettingsForSender: (...a: unknown[]) => mockVerifySettings(...a),
  handleInboundMessage: (...a: unknown[]) => mockInbound(...a) }));
jest.mock('@/lib/services/zavu/template-delivery-events', () => ({ reconcileTemplateDeliveryEvent: (...a: unknown[]) => mockTemplate(...a) }));
jest.mock('@/lib/services/zavu/audio-delivery-events', () => ({ reconcileAudioDeliveryEvent: (...a: unknown[]) => mockAudio(...a) }));
jest.mock('@/lib/services/zavu/whatsapp-app-echo', () => ({ isWhatsAppAppEcho: () => false }));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: (value: string) => value }));
jest.mock('@/lib/services/provider-webhook-claims', () => ({ claimProviderWebhookEvent: (...a: unknown[]) => mockClaim(...a),
  finishProviderWebhookEvent: (...a: unknown[]) => mockFinish(...a) }));

const projectSecret = randomBytes(32).toString('hex'), senderSecret = randomBytes(32).toString('hex');
const oldSecret = process.env.ZAVUDEV_WEBHOOK_SECRET;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.ZAVUDEV_WEBHOOK_SECRET = projectSecret;
  mockVerifySettings.mockResolvedValue([]);
  mockClaim.mockResolvedValue({ state: 'claimed', token: 'local-lease' });
  mockFinish.mockResolvedValue(true);
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('No network in receipt processing'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(mockInbound).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  if (oldSecret === undefined) delete process.env.ZAVUDEV_WEBHOOK_SECRET;
  else process.env.ZAVUDEV_WEBHOOK_SECRET = oldSecret;
});

const conn = { id: 'account-b', type: 'telegram', zavu_sender_id: 'sender-b' };
const recipient = 'contact-123', origin = 'sender-local-inbound-id', from = `telegram:${recipient}`;
function fixture(media = false) {
  const field = media ? 'native_media_delivery' : 'pinned_text_delivery';
  const scope = { 'conversations.site_id': SITE, conversations: { site_id: SITE, channel: 'telegram', custom_data: { channel: 'telegram' } }, conversation_id: 'thread' };
  const user: Row = { ...scope, id: 'in-b', role: 'user', custom_data: { source: 'zavu_inbound_message', connection_id: conn.id,
    origin_message_id: origin, channel: 'telegram', zavu_from: from, zavu_sender_id: 'sender-b' } };
  const meta: Row = { connection_id: conn.id, reply_to_message_id: user.id, origin_message_id: origin, response_format: 'text',
    ...(media ? { message_type: 'image', media_url: 'https://media.example.test/file.jpg', mime_type: 'image/jpeg' } : {}), status: 'reconciliation_required' };
  const reply: Row = { ...scope, id: 'reply-b', content: media ? '' : 'Saved reply', custom_data: meta, role: 'assistant' };
  const id = randomUUID();
  meta[field] = { id, state: 'attempting', payload_hash: pinnedReplyPayloadHash(reply.content, meta), provider: 'zavu', site_id: SITE,
    conversation_id: reply.conversation_id, message_id: reply.id, inbound_message_id: user.id, origin_message_id: origin,
    zavu_from: from, channel: 'telegram', connection_id: conn.id, recipient, sender_id: 'sender-b' };
  const db = inboundDatabase(mockFrom, { messages: [user, reply], settings: [{ site_id: SITE, channels: { connections: [
    { id: 'account-a', type: 'telegram', zavu_sender_id: 'sender-a' }, { ...conn } ] } }] });
  const event = (status: string, echo = true, provider = 'provider-1'): any => ({ id: randomUUID(), type: `message.${status}`,
    senderId: 'sender-b', site_id: 'not-authority', data: { channel: 'telegram', to: recipient, messageId: provider, direction: 'outbound',
      ...(echo ? { metadata: { channel_reply_attempt: id } } : {}) } });
  return { db, reply, meta, field, attempt: meta[field] as Row, user, event, id };
}
function request(event: any, secret = projectSecret) {
  const t = Math.floor(Date.now() / 1000), body = JSON.stringify(event);
  const h = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return new Request('https://api.example.test/api/integrations/zavu/webhook', { method: 'POST', body, headers: { 'x-zavu-signature': `t=${t},v2=${h}` } });
}

test.each([false, true])('signed callback resolves the original attempt despite lost HTTP receipt (media=%s)', async media => {
  const { db, reply, field, id, event } = fixture(media);
  // Identical contact/origin on another number, and a copied ID in a foreign tenant.
  const other = structuredClone(reply);
  other.id = 'reply-a'; other.custom_data[field].id = randomUUID(); other.custom_data[field].connection_id = 'account-a';
  const foreign = structuredClone(reply); foreign.id = 'foreign-reply'; foreign['conversations.site_id'] = OTHER_SITE; foreign.conversations.site_id = OTHER_SITE;
  db.tables.messages.push(other, foreign);
  const before = structuredClone([other, foreign]);
  expect((await callback(request(event('queued')))).status).toBe(200);
  expect(reply.custom_data).toMatchObject({ status:'queued', provider_message_id:'provider-1', [field]:{ id, state:'accepted', provider_message_id:'provider-1' } });
  expect(reply.custom_data.delivered_at).toBeUndefined();
  for (const status of ['sending', 'sent', 'failed', 'queued', 'delivered', 'failed', 'read', 'sent', 'read']) {
    expect((await callback(request(event(status, false)))).status).toBe(200);
    if (status === 'queued') expect(reply.custom_data).toMatchObject({ status:'failed', [field]:{state:'failed'} });
  }
  expect(reply.custom_data).toMatchObject({ status:'read', [field]:{ id, state:'accepted' } });
  expect(db.operations.filter(op => op.kind === 'update')).toHaveLength(6);
  expect([other, foreign]).toEqual(before);
  expect(mockTemplate).not.toHaveBeenCalled(); expect(mockAudio).not.toHaveBeenCalled();
});

test('early untagged event cannot be attributed by contact; retries only after exact provider ID is available', async () => {
  const { reply, event, attempt, meta } = fixture();
  const e = event('read', false);
  expect((await callback(request(e))).status).toBe(500);
  expect(mockFinish).toHaveBeenLastCalledWith('zavu', e.id, 'local-lease', 'failed', expect.stringContaining('not yet available'));
  expect(reply.custom_data.provider_message_id).toBeUndefined();
  Object.assign(meta, { provider_message_id: e.data.messageId, status: 'sent' }); attempt.state = 'accepted';
  expect((await callback(request(e))).status).toBe(200);
  expect(reply.custom_data).toMatchObject({ status: 'read', pinned_text_delivery:{provider_message_id:e.data.messageId} });
});

test('uses the sender-specific authenticated site even if settings rebind during admission', async () => {
  const { reply, event, db } = fixture();
  mockVerifySettings.mockResolvedValue([{ site_id: OTHER_SITE, channels: { connections: [{ ...conn, metadata: { zavu_webhook_secret: senderSecret } }] } }]);
  const e = event('delivered'); e.site_id = SITE;
  expect((await callback(request(e, senderSecret))).status).toBe(500);
  expect(mockClaim).toHaveBeenCalled(); expect(reply.custom_data.status).toBe('reconciliation_required');
  expect(db.operations.every(op => op.table === 'settings')).toBe(true);
});

test('only the original signed provider callback may reconcile; invalid signature and neutral URL cannot claim', async () => {
  const { db, event } = fixture();
  const e = event('read');
  expect((await callback(request(e, randomBytes(32).toString('hex')))).status).toBe(401);
  expect((await inboundOnly(request(e))).status).toBe(400);
  const noSig = request(e); noSig.headers.delete('x-zavu-signature');
  expect((await callback(noSig)).status).toBe(401);
  expect(mockClaim).not.toHaveBeenCalled(); expect(db.operations).toHaveLength(0);
});

test('a generic completed envelope claim can suppress reconciliation but does not prove provider acceptance', async () => {
  const { db, reply, event } = fixture(); mockClaim.mockResolvedValueOnce({state:'completed'});
  const result = await callback(request(event('delivered')));
  expect(await result.json()).toEqual({success:true,duplicate:true}); expect(reply.custom_data.status).toBe('reconciliation_required');
  expect(db.operations).toHaveLength(0);
});

test.each(['provider','site_id','conversation_id','message_id','inbound_message_id','origin_message_id','zavu_from','channel','connection_id','recipient','sender_id','payload_hash'])('checks every immutable attempt field (%s)', async key => {
  const { db, attempt, event } = fixture();
  attempt[key] = 'changed';
  await expect(reconcile(event('delivered'))).rejects.toThrow();
  expect(db.operations.some(op => op.kind === 'update')).toBe(false);
});

test.each(['new caption', 'new media URL', 'new MIME', 'thread channel', 'metadata channel', 'wrong role', 'other thread', 'other site',
  'inbound link', 'inbound sender', 'inbound from', 'inbound origin', 'inbound channel', 'inbound role', 'foreign inbound',
  'comment', 'reply sender', 'reply account source', 'reply from', 'outstand', 'draft', 'skip state', 'skip marker', 'quarantine', 'failed contradiction', 'two receipts', 'audio delivery', 'generic media'])('changed or ambiguous durable binding is not repaired: %s', async change => {
  const { db, attempt, meta, user, event, reply } = fixture(true);
  switch (change) {
    case 'new caption': reply.content = 'Updated'; break;
    case 'new media URL': meta.media_url += '?replacement'; break;
    case 'new MIME': meta.mime_type = 'video/mp4'; break;
    case 'thread channel': reply.conversations.channel = 'whatsapp'; break;
    case 'metadata channel': reply.conversations.custom_data.channel = 'instagram'; break;
    case 'wrong role': reply.role = 'team_member'; break;
    case 'other thread': reply.conversation_id = 'different'; break;
    case 'other site': reply['conversations.site_id'] = OTHER_SITE; break;
    case 'inbound link': meta.reply_to_message_id = 'other-inbound'; break;
    case 'inbound sender': user.custom_data.zavu_sender_id = 'sender-a'; break;
    case 'inbound from': user.custom_data.zavu_from = 'contact-123'; break;
    case 'inbound origin': user.custom_data.origin_message_id = 'another-origin'; break;
    case 'inbound channel': user.custom_data.channel = 'email'; break;
    case 'inbound role': user.role = 'assistant'; break;
    case 'foreign inbound': user['conversations.site_id'] = OTHER_SITE; break;
    case 'comment': meta.source = 'social_comment'; break;
    case 'reply sender': meta.zavu_sender_id = 'another-sender'; break;
    case 'reply account source': meta.source = 'outstand'; break;
    case 'reply from': meta.zavu_from = 'foreign-contact'; break;
    case 'outstand': reply.conversations.custom_data.outstand_conversation_id = 'foreign'; break;
    case 'draft': meta.status = 'pending'; break;
    case 'skip state': attempt.state = 'skipped'; break;
    case 'skip marker': meta.automation_skipped = true; break;
    case 'quarantine': attempt.state = 'conflict'; break;
    case 'failed contradiction': Object.assign(meta, {status:'read',provider_message_id:'provider-1'}); attempt.state = 'failed'; break;
    case 'two receipts': meta.pinned_text_delivery = attempt; break;
    case 'audio delivery': meta.audio_delivery = {}; break;
    case 'generic media': meta.native_media_delivery = {provider:'zavu', id:attempt.id, state:'attempting'}; break;
  }
  await expect(reconcile(event('read'))).rejects.toThrow();
  expect(db.operations.some(op => op.kind === 'update')).toBe(false);
});

test.each(['sender aliases', 'no to', 'wrong target', 'wrong sender', 'wrong channel', 'no ID', 'placeholder ID', 'reversed direction', 'status contradiction', 'wrong echo', 'null echo', 'two echoes'])('does not use contradictory or incomplete event data: %s', async change => {
  const { db, event, meta, attempt } = fixture();
  Object.assign(meta, {status: 'queued', provider_message_id: 'provider-1'}); Object.assign(attempt, {state:'accepted',provider_message_id:'provider-1'});
  const e = event('read');
  switch (change) {
    case 'sender aliases': e.data.senderId = 'sender-a'; break;
    case 'no to': delete e.data.to; break;
    case 'wrong target': e.data.to = 'someone-else'; break;
    case 'wrong sender': e.senderId = 'sender-a'; break;
    case 'wrong channel': e.data.channel = 'email'; break;
    case 'no ID': delete e.data.messageId; break;
    case 'placeholder ID': e.data.messageId = 'unknown'; break;
    case 'reversed direction': e.data.direction = 'inbound'; break;
    case 'status contradiction': e.data.status = 'failed'; break;
    case 'wrong echo': e.data.metadata.channel_reply_attempt = randomUUID(); break;
    case 'null echo': e.data.metadata.channel_reply_attempt = null; break;
    case 'two echoes': e.metadata = {channel_reply_attempt:randomUUID()}; break;
  }
  await expect(reconcile(e)).rejects.toThrow();
  expect(db.operations.some(op => op.kind === 'update')).toBe(false);
});

test.each(['duplicate site','duplicate connection','duplicate ID','deleted connection','two attempt IDs','two provider IDs','two different matches','mixed receipt kinds'])('unique bindings only (%s)', async kind => {
  const { db, event, reply, meta, attempt } = fixture(); const conns = db.tables.settings[0].channels.connections;
  const other = structuredClone(reply); other.id = 'other'; other.custom_data.pinned_text_delivery.message_id = other.id;
  if (kind === 'duplicate site') db.tables.settings.push({site_id:OTHER_SITE,channels:{connections:[{...conn}]}});
  if (kind === 'duplicate connection') conns.push({...conn, id:'other'});
  if (kind === 'duplicate ID') conns.push({...conn,zavu_sender_id:'other'});
  if (kind === 'deleted connection') conns.pop();
  if (kind === 'two attempt IDs') db.tables.messages.push(other);
  if (kind === 'two provider IDs') {
    Object.assign(meta, {status:'sent', provider_message_id:'provider-1'}); Object.assign(attempt, {state:'accepted',provider_message_id:'provider-1'});
    other.custom_data.provider_message_id = 'provider-1'; other.custom_data.pinned_text_delivery.id = randomUUID(); db.tables.messages.push(other);
  }
  if (kind === 'two different matches') {
    other.custom_data.pinned_text_delivery.id = randomUUID(); other.custom_data.pinned_text_delivery.provider_message_id = 'provider-1';
    db.tables.messages.push(other);
  }
  if (kind === 'mixed receipt kinds') {
    delete other.custom_data.pinned_text_delivery; other.custom_data.template_delivery = {provider_message_id:'provider-1'}; db.tables.messages.push(other);
  }
  await expect(reconcile(event('read', kind !== 'two provider IDs'))).rejects.toThrow();
  expect(db.operations.some(op => op.kind === 'update')).toBe(false);
});

test('a stale event or generic pre-pin media is not evidence for a pinned send', async () => {
  const { db, meta, event, attempt } = fixture(true);
  meta.native_media_delivery = {provider:'zavu', id:attempt.id, state:'accepted'};
  meta.status = 'sent'; meta.provider_message_id = 'provider-1';
  expect(await reconcile(event('read', false))).toBe(false);
  expect(db.operations.some(op => op.kind === 'update')).toBe(false);
});

test('provider ID with reserved punctuation stays a single literal', async () => {
  const { reply, event } = fixture(); const provider = 'provider:quoted"\\,(x)';
  expect(await reconcile(event('sent', true, provider))).toBe(true);
  expect(await reconcile(event('read', false, provider))).toBe(true);
  expect(reply.custom_data).toMatchObject({ status:'read',provider_message_id:provider });
});

test.each(['metadata','stronger receipt','moved row','changed content','provider mismatch','new attempt','endless contention'])('CAS rejects stale state and never switches original row or attempt (%s)', async kind => {
  const { db, reply, meta, attempt, event } = fixture(); let count = 0;
  db.beforeUpdate = () => {
    count++;
    if (kind !== 'endless contention') db.beforeUpdate = undefined;
    if (kind === 'metadata') meta.reviewed = true;
    if (kind === 'stronger receipt') { Object.assign(meta, {status:'read',provider_message_id:'provider-1'}); Object.assign(attempt, {state:'accepted',provider_message_id:'provider-1'}); }
    if (kind === 'moved row') { reply.conversation_id = 'elsewhere'; }
    if (kind === 'changed content') reply.content += '!';
    if (kind === 'provider mismatch') { Object.assign(meta, {status:'sent', provider_message_id:'first-id'}); Object.assign(attempt, {state:'accepted',provider_message_id:'first-id'}); }
    if (kind === 'new attempt') attempt.id = randomUUID();
    if (kind === 'endless contention') meta.revision = count;
  };
  if (kind === 'metadata' || kind === 'stronger receipt') {
    expect(await reconcile(event('sent'))).toBe(true);
    if (kind === 'metadata') expect(reply.custom_data).toMatchObject({status:'sent',reviewed:true});
    else expect(reply.custom_data.status).toBe('read');
  } else {
    await expect(reconcile(event('sent'))).rejects.toThrow();
    expect(reply.custom_data.provider_message_id).not.toBe('provider-1');
    if (kind === 'endless contention') expect(count).toBe(3);
  }
});

test.each(['settings','messages','update'])('retry on database error, no private error detail retained (%s)', async where => {
  const { db, reply, event } = fixture(); db.failNextTable = where === 'update' ? 'messages' : where;
  db.failNextKind = where === 'update' ? 'update' : 'read'; const e = event('read');
  expect((await callback(request(e))).status).toBe(500);
  expect(mockFinish).toHaveBeenLastCalledWith('zavu',e.id,'local-lease','failed','Pinned delivery receipt store is unavailable');
  expect(reply.custom_data.status).toBe('reconciliation_required');
});

test('quarantines contradictory provider identities for a proven attempt without replacing the original read or ID', async () => {
  const { reply, event, field } = fixture();
  expect(await reconcile(event('read'))).toBe(true);
  await expect(reconcile(event('sent', true, 'provider-2'))).rejects.toThrow();
  const held = structuredClone(reply.custom_data);
  expect(held).toMatchObject({ status: 'read', provider_message_id:'provider-1', [field]: {
    state:'conflict', provider_message_id:'provider-1', conflicting_provider_message_id:'provider-2' } });
  await expect(reconcile(event('read'))).rejects.toThrow();
  await expect(reconcile(event('delivered', true,'provider-2'))).rejects.toThrow();
  expect(reply.custom_data).toEqual(held);
});

test('an ID mismatch cannot quarantine someone else’s receipt via a changed sender or swapped payload', async () => {
  const { reply, event, field } = fixture();
  expect(await reconcile(event('sent'))).toBe(true);
  const e = event('read', true, 'other-id'); e.senderId = 'sender-a';
  await expect(reconcile(e)).rejects.toThrow();
  e.senderId = 'sender-b'; reply.content = 'edited';
  await expect(reconcile(e)).rejects.toThrow();
  expect(reply.custom_data[field].state).toBe('accepted');
  expect(reply.custom_data[field].conflicting_provider_message_id).toBeUndefined();
});

test.each(['same', 'different'])('sender-specific signature binds the verified connection, not just its site (%s)', async same => {
  const { reply, event } = fixture();
  mockVerifySettings.mockResolvedValue([{ site_id:SITE, channels: {connections:[{...conn,
    id: same === 'same' ? conn.id : 'prior-connection', metadata:{zavu_webhook_secret:senderSecret}}] } }]);
  expect((await callback(request(event('delivered'), senderSecret))).status).toBe(same === 'same' ? 200 : 500);
  expect(reply.custom_data.status).toBe(same === 'same' ? 'delivered' : 'reconciliation_required');
});

test.each(['missing site','blank connection','different channel','ambiguous sender-secret connection'])('sender-secret message verification fails before claiming: %s', async kind => {
  const { db, event } = fixture(); const c: Row = {...conn, metadata:{zavu_webhook_secret:senderSecret}};
  const site = { site_id:kind === 'missing site' ? '' : SITE, channels:{connections:[c]} };
  if (kind === 'blank connection') c.id = ' ';
  if (kind === 'different channel') c.type = 'whatsapp';
  if (kind === 'ambiguous sender-secret connection') site.channels.connections.push({...c, id:'duplicate'});
  mockVerifySettings.mockResolvedValue([site]);
  expect((await callback(request(event('read'),senderSecret))).status).toBe(401);
  expect(mockClaim).not.toHaveBeenCalled(); expect(db.operations).toHaveLength(0);
});
