import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import {
  authorizeOutstandConversation,
  requireOutstandConversationSite,
} from '@/lib/integrations/outstand/conversation-access';
import { recordOutstandMessage } from '@/lib/integrations/outstand/inbox-sync';
import { POST } from '../route';

jest.mock('@/lib/integrations/outstand/client', () => ({
  getOutstandClient: jest.fn(),
}));
jest.mock('@/lib/integrations/outstand/conversation-access', () => ({
  authorizeOutstandConversation: jest.fn(),
  requireOutstandConversationSite: jest.fn(),
}));
jest.mock('@/lib/integrations/outstand/inbox-sync', () => ({
  recordOutstandMessage: jest.fn(),
}));

const sendConversationMessage = jest.fn();
const SITE_ID = '00000000-0000-4000-8000-000000000001';

describe('Outstand conversation messages route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getOutstandClient as jest.Mock).mockReturnValue({
      sendConversationMessage,
    });
    sendConversationMessage.mockResolvedValue({
      success: true,
      message: { id: 'message-1', status: 'pending' },
    } as never);
    (requireOutstandConversationSite as jest.Mock).mockResolvedValue(SITE_ID as never);
    (authorizeOutstandConversation as jest.Mock).mockResolvedValue({
      success: true,
      conversation: {
        id: 'conversation-1',
        socialAccountId: 'account-1',
      },
    } as never);
    (recordOutstandMessage as jest.Mock).mockResolvedValue(undefined as never);
  });

  it('returns 202 when Outstand accepts a scheduled message', async () => {
    const scheduledAt = new Date(Date.now() + 60_000).toISOString();
    const request = new Request(
      `http://localhost/api/integrations/outstand/conversations/conversation-1/messages?tenant_id=${SITE_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello',
          media_urls: ['https://cdn.example.com/image.jpg'],
          scheduled_at: scheduledAt,
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: 'conversation-1' }),
    });

    expect(response.status).toBe(202);
    expect(sendConversationMessage).toHaveBeenCalledWith(
      'conversation-1',
      {
        content: 'Hello',
        media_urls: ['https://cdn.example.com/image.jpg'],
        scheduled_at: scheduledAt,
      },
    );
    expect(authorizeOutstandConversation).toHaveBeenCalledWith(
      expect.anything(),
      'conversation-1',
      SITE_ID,
    );
  });

  it('rejects a scheduled message whose delivery time has passed', async () => {
    const request = new Request(
      'http://localhost/api/integrations/outstand/conversations/conversation-1/messages',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello',
          scheduled_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: 'conversation-1' }),
    });

    expect(response.status).toBe(400);
    expect(sendConversationMessage).not.toHaveBeenCalled();
  });

  it('does not send when site access is denied', async () => {
    (requireOutstandConversationSite as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('You do not have access to this site'), {
        status: 403,
      }) as never,
    );
    const request = new Request(
      `http://localhost/api/integrations/outstand/conversations/conversation-1/messages?tenant_id=${SITE_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: 'conversation-1' }),
    });

    expect(response.status).toBe(403);
    expect(sendConversationMessage).not.toHaveBeenCalled();
  });
});
