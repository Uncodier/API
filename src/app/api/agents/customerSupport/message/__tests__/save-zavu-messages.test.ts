import { saveZavuSupportMessages, supportRecordId } from '../save-zavu-messages';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: jest.fn() } }));

describe('durable Zavu message identity', () => {
  let tables: Record<string, Map<string, any>>;
  let failAssistant: boolean;
  const input = { siteId: 'site', userId: 'user', agentId: 'agent', userMessage: 'Hola',
    assistantMessage: 'Bienvenido', originMessageId: 'provider-message', channel: 'whatsapp',
    metadata: { source: 'zavu_inbound_message', connection_id: 'connection', zavu_sender_id: 'sender', zavu_from: 'contact' } };

  beforeEach(() => {
    tables = { messages: new Map(), conversations: new Map() };
    failAssistant = false;
    jest.mocked(supabaseAdmin.schema).mockImplementation(() => ({ from: (table: string) => {
      const filters: [string, unknown][] = [];
      const query: any = {
        select: () => query, order: () => query, limit: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        maybeSingle: async () => ({ error: null, data: [...tables[table].values()].find(row => filters.every(([key, value]) => {
          if (key === 'conversations.site_id') return tables.conversations.get(row.conversation_id)?.site_id === value;
          if (key.startsWith('custom_data->>')) return row.custom_data?.[key.split('->>')[1]] === value;
          return row[key] === value;
        })) || null }),
        insert: async (row: any) => {
          if (table === 'messages' && row.role === 'assistant' && failAssistant) {
            failAssistant = false; return { error: { code: 'unavailable' } };
          }
          if (tables[table].has(row.id)) return { error: { code: '23505' } };
          tables[table].set(row.id, row); return { error: null };
        },
      };
      return query;
    } }) as any);
  });

  it('uses stable scoped UUIDs', () => {
    const id = supportRecordId(['scope', 'message']);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).toBe(supportRecordId(['scope', 'message']));
    expect(id).not.toBe(supportRecordId(['other-scope', 'message']));
  });

  it.each([true, false])('persists audio format separately from content (approval %s)', async requireApproval => {
    const result = await saveZavuSupportMessages({ ...input, responseFormat: 'audio', requireApproval });
    const assistant = tables.messages.get(result.assistantMessageId);
    expect(assistant.content).toBe(input.assistantMessage);
    expect(assistant.custom_data.response_format).toBe('audio');
    expect(assistant.custom_data.status).toBe(requireApproval ? 'pending' : undefined);
    expect(tables.messages.get(result.userMessageId).custom_data.response_format).toBeUndefined();
    expect(await saveZavuSupportMessages({ ...input, responseFormat: 'audio', requireApproval })).toEqual(result);
  });

  it('fails closed if a retry attempts to change the persisted delivery format', async () => {
    await saveZavuSupportMessages({ ...input, responseFormat: 'audio' });
    await expect(saveZavuSupportMessages({ ...input, responseFormat: 'text' })).rejects.toThrow('SCOPE_CONFLICT');
  });

  it('returns the same messages for a completed retry without overwriting delivery state', async () => {
    const first = await saveZavuSupportMessages(input);
    tables.messages.get(first.assistantMessageId).custom_data.status = 'sent';
    expect(await saveZavuSupportMessages(input)).toEqual(first);
    expect(tables.messages.size).toBe(2);
    expect(tables.messages.get(first.assistantMessageId).custom_data.status).toBe('sent');
  });

  it('deduplicates simultaneous first requests including the conversation', async () => {
    const [a, b] = await Promise.all([saveZavuSupportMessages(input), saveZavuSupportMessages(input)]);
    expect(a).toEqual(b);
    expect(tables.messages.size).toBe(2);
    expect(tables.conversations.size).toBe(1);
  });

  it('recovers an inbound-only partial save', async () => {
    failAssistant = true;
    await expect(saveZavuSupportMessages(input)).rejects.toThrow('MESSAGE_SAVE_FAILED');
    expect(tables.messages.size).toBe(1);
    await saveZavuSupportMessages(input);
    expect(tables.messages.size).toBe(2);
  });

  it('reuses a legacy inbound without inserting it again', async () => {
    tables.conversations.set('legacy', { id: 'legacy', site_id: input.siteId });
    tables.messages.set('old-inbound', { id: 'old-inbound', conversation_id: 'legacy', role: 'user',
      content: input.userMessage, custom_data: { ...input.metadata, origin_message_id: input.originMessageId } });
    const result = await saveZavuSupportMessages(input);
    expect(result.userMessageId).toBe('old-inbound');
    expect(result.conversationId).toBe('legacy');
    expect(tables.messages.size).toBe(2);
  });

  it('does not overwrite conflicting responses for the same event', async () => {
    await saveZavuSupportMessages(input);
    await expect(saveZavuSupportMessages({ ...input, assistantMessage: 'Different' })).rejects.toThrow('SCOPE_CONFLICT');
  });

  it('rejects a conversation from another site', async () => {
    tables.conversations.set('other', { id: 'other', site_id: 'other-site' });
    await expect(saveZavuSupportMessages({ ...input, conversationId: 'other' })).rejects.toThrow('SCOPE_CONFLICT');
    expect(tables.messages.size).toBe(0);
  });
});