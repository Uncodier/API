import { readSupportSnooze, resolveSnoozeConversation, saveSnoozedSupportInput } from '../snooze';
import { supportRecordId } from '../save-zavu-messages';

const query: any = {};
let results: any[] = [];
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  schema: () => ({ from: (...args: any[]) => query.from(...args) }),
} }));

beforeEach(() => {
  results = [];
  for (const method of ['from', 'select', 'eq', 'in', 'order', 'limit', 'insert', 'update']) {
    query[method] = jest.fn(() => query);
  }
  query.maybeSingle = jest.fn(async () => results.shift());
  query.then = (resolve: any, reject: any) => Promise.resolve(results.shift()).then(resolve, reject);
});

const input = { siteId: 'site', conversationId: 'conversation', startedAt: '2026-01-01T10:00:00Z' };

it('scopes the state read to the conversation and tenant', async () => {
  results.push({ data: { id: 'conversation', automation_paused_until: '2099-01-01T00:00:00Z' } });
  expect(await readSupportSnooze(input)).toMatchObject({ conversationId: 'conversation' });
  expect(query.eq).toHaveBeenCalledWith('site_id', 'site');
  expect(query.eq).toHaveBeenCalledWith('id', 'conversation');
});

it('allows new turns after expiry but suppresses turns superseded by a human', async () => {
  const data = { id: 'conversation', automation_paused_until: '2020-01-01T00:00:00Z',
    last_human_reply_at: '2026-01-01T09:00:00Z' };
  results.push({ data }, { data: { ...data, last_human_reply_at: '2026-01-01T11:00:00Z' } });
  expect(await readSupportSnooze(input)).toBeNull();
  expect(await readSupportSnooze(input)).toMatchObject({ conversationId: 'conversation' });
});

it('fails closed on database errors instead of generating a response', async () => {
  results.push({ error: { message: 'unavailable' } });
  await expect(readSupportSnooze(input)).rejects.toThrow('SNOOZE_LOOKUP_FAILED');
});

it('keeps a previously skipped provider message terminal after expiry', async () => {
  results.push({ data: { id: 'conversation', automation_paused_until: '2020-01-01T00:00:00Z' } },
    { data: { id: 'saved-inbound' } });
  expect(await readSupportSnooze({ ...input, originMessageId: 'provider-id' }))
    .toMatchObject({ conversationId: 'conversation' });
  expect(query.eq).toHaveBeenCalledWith('custom_data->>skip_reason', 'agent_snoozed');
});

it('resolves provider history using exact sender, connection and recipient', async () => {
  results.push({ data: { conversation_id: 'exact-conversation' } });
  expect(await resolveSnoozeConversation({ ...input, metadata: {
    source: 'zavu_inbound_message', connection_id: 'connection', zavu_sender_id: 'sender', zavu_from: 'recipient',
  } })).toBe('exact-conversation');
  expect(query.eq).toHaveBeenCalledWith('conversations.site_id', 'site');
  expect(query.eq).toHaveBeenCalledWith('custom_data->>zavu_sender_id', 'sender');
  expect(query.eq).toHaveBeenCalledWith('custom_data->>zavu_from', 'recipient');
  expect(query.from).toHaveBeenCalledWith('messages');
  expect(query.in).not.toHaveBeenCalled();
});

describe('WhatsApp canonical conversation resolution', () => {
  const variants = ['+5215555550123', '5215555550123', 'whatsapp:+5215555550123', 'whatsapp:5215555550123'];
  const contact = (from = variants[0]) => ({ siteId: 'site', conversationId: 'untrusted-request-conversation', metadata: {
    source: 'zavu_inbound_message', channel: 'whatsapp', connection_id: 'connection',
    zavu_sender_id: 'sender', zavu_from: from,
  } });

  it.each(variants)('resolves %s to the same existing conversation using all exact aliases', async from => {
    results.push({ data: [{ id: 'existing-conversation' }], error: null });
    await expect(resolveSnoozeConversation(contact(from))).resolves.toBe('existing-conversation');
    expect(query.from).toHaveBeenCalledWith('conversations');
    expect(query.select).toHaveBeenCalledWith('id, messages!inner()');
    expect(query.eq).toHaveBeenCalledWith('site_id', 'site');
    expect(query.eq).toHaveBeenCalledWith('messages.role', 'user');
    expect(query.eq).toHaveBeenCalledWith('messages.custom_data->>connection_id', 'connection');
    expect(query.eq).toHaveBeenCalledWith('messages.custom_data->>zavu_sender_id', 'sender');
    expect(query.in).toHaveBeenCalledWith('messages.custom_data->>zavu_from', variants);
    expect(query.limit).toHaveBeenCalledWith(2);
    expect(query.order).not.toHaveBeenCalled();
    expect(query.maybeSingle).not.toHaveBeenCalled();
    expect(query.insert).not.toHaveBeenCalled();
  });

  it('uses one canonical deterministic fallback for all aliases, preserving every digit', async () => {
    const ids = [];
    for (const from of variants) {
      results.push({ data: [], error: null });
      ids.push(await resolveSnoozeConversation(contact(from)));
    }
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(supportRecordId(['support-conversation-v1', 'site', 'connection', variants[0]]));
    results.push({ data: [], error: null });
    expect(await resolveSnoozeConversation(contact('+525555550123'))).not.toBe(ids[0]);
  });

  it('keeps long/multi-alias message histories scoped at the conversation root rather than limiting messages', async () => {
    // PostgREST returns one root row even when many joined inbound messages match.
    results.push({ data: [{ id: 'one-conversation' }], error: null });
    await expect(resolveSnoozeConversation(contact())).resolves.toBe('one-conversation');
    expect(query.from.mock.calls).toEqual([['conversations']]);
    expect(query.limit.mock.calls).toEqual([[2]]);
  });

  it('fails closed on distinct matching conversations before any writes', async () => {
    results.push({ data: [{ id: 'first' }, { id: 'second' }], error: null });
    await expect(resolveSnoozeConversation(contact())).rejects.toThrow('CUSTOMER_SUPPORT_SNOOZE_SCOPE_CONFLICT');
    expect(query.insert).not.toHaveBeenCalled();
    expect(query.update).not.toHaveBeenCalled();
  });

  it.each([null, undefined, {}, { id: 'not-an-array' }, [null], [{}], [{ id: '' }], [{ id: 42 }]])
  ('fails closed on malformed conversation results %p', async data => {
    results.push({ data, error: null });
    await expect(resolveSnoozeConversation(contact())).rejects.toThrow('CUSTOMER_SUPPORT_SNOOZE_LOOKUP_FAILED');
    expect(query.insert).not.toHaveBeenCalled();
  });

  it('fails closed on database errors even with valid-looking results', async () => {
    results.push({ data: [{ id: 'conversation' }], error: { message: 'database unavailable' } });
    await expect(resolveSnoozeConversation(contact())).rejects.toThrow('CUSTOMER_SUPPORT_SNOOZE_LOOKUP_FAILED');
  });

  it.each(['+1 (555) 555-0123', '15555550123@g.us', '0015555550123', ''])
  ('rejects malformed WhatsApp identity %s before querying', async from => {
    await expect(resolveSnoozeConversation(contact(from))).rejects.toThrow('CUSTOMER_SUPPORT_SNOOZE_CONTACT_INVALID');
    expect(query.from).not.toHaveBeenCalled();
  });

  it('retains exact raw-recipient fallback hashing for non-WhatsApp channels', async () => {
    const request = contact('telegram:@customer');
    request.metadata.channel = 'telegram';
    results.push({ data: null, error: null });
    await expect(resolveSnoozeConversation(request)).resolves.toBe(
      supportRecordId(['support-conversation-v1', 'site', 'connection', 'telegram:@customer']));
    expect(query.from).toHaveBeenCalledWith('messages');
    expect(query.eq).toHaveBeenCalledWith('custom_data->>zavu_from', 'telegram:@customer');
    expect(query.in).not.toHaveBeenCalled();
  });
});

it('preserves only an inbound row with stable identity and no assignment writes', async () => {
  results.push({ error: null }, { error: null });
  const args = { ...input, userId: 'owner', message: 'Hello', originMessageId: 'provider-message' };
  const state = { conversationId: 'conversation', pausedUntil: '2099-01-01T00:00:00Z' };
  const first = await saveSnoozedSupportInput(args, state);
  const second = await saveSnoozedSupportInput(args, state);
  expect(first).toEqual(second);
  expect(first.data.messages).not.toHaveProperty('assistant');
  expect(query.insert).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: 'Hello' }));
  expect(query.from.mock.calls.every(([table]: string[]) => table === 'messages')).toBe(true);
});

it('accepts matching duplicate input, but never reuses a conflicting row', async () => {
  results.push({ error: { code: '23505' } }, { data: { conversation_id: 'conversation', role: 'user', content: 'Hello',
    custom_data: { skip_reason: 'agent_snoozed' } } },
    { error: { code: '23505' } }, { data: { conversation_id: 'other', role: 'user', content: 'Hello' } });
  const args = { ...input, userId: 'owner', message: 'Hello', originMessageId: 'provider-message' };
  const state = { conversationId: 'conversation', pausedUntil: null };
  await expect(saveSnoozedSupportInput(args, state)).resolves.toHaveProperty('success', true);
  await expect(saveSnoozedSupportInput(args, state)).rejects.toThrow('SNOOZE_SCOPE_CONFLICT');
});

it('marks an inbound already persisted before generation as terminal using its original ID', async () => {
  results.push({ error: { code: '23505' } }, { data: {
    conversation_id: 'conversation', role: 'user', content: 'Hello', updated_at: '2026-01-01T10:00:00Z',
    custom_data: { connection_id: 'connection', keep: true },
  } }, { data: { id: 'original-inbound' } });
  const result = await saveSnoozedSupportInput({ ...input, userId: 'owner', message: 'Hello',
    originMessageId: 'provider', persistedInboundId: 'original-inbound' },
  { conversationId: 'conversation', pausedUntil: null });
  expect(result.data.messages.user.message_id).toBe('original-inbound');
  expect(query.update).toHaveBeenCalledWith({ custom_data: {
    connection_id: 'connection', keep: true, response_skipped: true, automation_paused: true, skip_reason: 'agent_snoozed',
  } });
  expect(query.eq).toHaveBeenCalledWith('updated_at', '2026-01-01T10:00:00Z');
});