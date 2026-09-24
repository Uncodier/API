import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

import { bindLocalOutstandMessage } from '../inbox-sync';

function lookupQuery(data: unknown) {
  const query: Record<string, any> = {};
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.filter = jest.fn(() => query);
  query.maybeSingle = jest.fn().mockResolvedValue({ data, error: null } as never);
  return query;
}

function mutationQuery(method: 'update' | 'delete') {
  const query: Record<string, any> = { error: null };
  query[method] = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  return query;
}

describe('Outstand outbound message binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('merges an early webhook duplicate into the original local message', async () => {
    const localLookup = lookupQuery({
      id: 'local-message-1',
      custom_data: { command_status: 'completed', status: 'pending' },
    });
    const initialUpdate = mutationQuery('update');
    const duplicateLookup = lookupQuery({
      id: 'duplicate-message-1',
      custom_data: {
        source: 'outstand_dm',
        status: 'sent',
        delivery_error: null,
      },
    });
    const duplicateDelete = mutationQuery('delete');
    const finalUpdate = mutationQuery('update');
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(localLookup)
      .mockReturnValueOnce(initialUpdate)
      .mockReturnValueOnce(duplicateLookup)
      .mockReturnValueOnce(duplicateDelete)
      .mockReturnValueOnce(finalUpdate);

    await bindLocalOutstandMessage({
      localMessageId: 'local-message-1',
      localConversationId: 'local-conversation-1',
      outstandConversationId: 'outstand-conversation-1',
      outstandMessageId: 'outstand-message-1',
    });

    expect(duplicateDelete.eq).toHaveBeenCalledWith('id', 'duplicate-message-1');
    expect(finalUpdate.update).toHaveBeenCalledWith({
      custom_data: expect.objectContaining({
        command_status: 'completed',
        source: 'outstand_dm',
        provider: 'outstand',
        status: 'sent',
        provider_message_id: 'outstand-message-1',
        outstand_message_id: 'outstand-message-1',
        outstand_conversation_id: 'outstand-conversation-1',
      }),
    });
  });
});
