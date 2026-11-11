import { readSupportSnooze, resolveSnoozeConversation, saveSnoozedSupportInput } from '../snooze';

const query: any = {};
let results: any[] = [];
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  schema: () => ({ from: (...args: any[]) => query.from(...args) }),
} }));

beforeEach(() => {
  results = [];
  for (const method of ['from', 'select', 'eq', 'order', 'limit', 'insert', 'update']) {
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