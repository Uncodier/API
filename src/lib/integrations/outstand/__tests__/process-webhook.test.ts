import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { processOutstandWebhookPayload } from '../process-webhook';
import { syncOutstandInboxWebhook } from '../inbox-sync';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));
jest.mock('../inbox-sync', () => ({
  syncOutstandInboxWebhook: jest.fn(),
}));

describe('processOutstandWebhookPayload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reconciles a received Instagram message into the local inbox', async () => {
    const payload = {
      event: 'message.received' as const,
      timestamp: '2026-09-23T21:00:01.000Z',
      data: {
        conversationId: 'conversation-1',
        messageId: 'message-1',
        orgId: 'org-1',
        network: 'instagram' as const,
        content: 'Hello',
        senderId: 'instagram-user-1',
        sentAt: '2026-09-23T21:00:00.000Z',
      },
    };

    await processOutstandWebhookPayload(payload);

    expect(syncOutstandInboxWebhook).toHaveBeenCalledWith(payload);
  });
});
