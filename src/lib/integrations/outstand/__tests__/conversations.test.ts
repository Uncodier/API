import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { OutstandClient } from '../client';

describe('OutstandClient Conversations API', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists Instagram conversations with cursor pagination without a fake tenant header', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        data: [],
        pagination: { hasMore: false, nextCursor: null, limit: 25 },
      })),
    );

    await new OutstandClient('secret').listConversations(
      {
        social_account_id: 'account-1',
        network: 'instagram',
        cursor: '42',
        limit: 25,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.outstand.so/v1/conversations?social_account_id=account-1&network=instagram&cursor=42&limit=25',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
        }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('X-Tenant-ID');
  });

  it('sends text, media, and a native scheduled_at value', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        message: { id: 'message-1', status: 'pending' },
      }), { status: 202 }),
    );

    await new OutstandClient('secret').sendConversationMessage(
      'conversation/1',
      {
        content: 'Hello',
        media_urls: ['https://cdn.example.com/image.jpg'],
        scheduled_at: '2026-09-24T12:00:00.000Z',
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.outstand.so/v1/conversations/conversation%2F1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          content: 'Hello',
          media_urls: ['https://cdn.example.com/image.jpg'],
          scheduled_at: '2026-09-24T12:00:00.000Z',
        }),
      }),
    );
  });

  it('marks a conversation read and cancels a scheduled message', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        id: 'conversation-1',
        unreadCount: 0,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        message: 'Message cancelled successfully',
      })));
    const client = new OutstandClient('secret');

    await client.markConversationRead('conversation-1');
    await client.cancelScheduledConversationMessage('conversation-1', 'message-1');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.outstand.so/v1/conversations/conversation-1/read',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.outstand.so/v1/conversations/conversation-1/messages/message-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('passes custom Instagram messaging scopes to the auth URL endpoint', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        data: { auth_url: 'https://instagram.example/authorize' },
      })),
    );

    await new OutstandClient('secret').getSocialAuthUrl('instagram', {
      redirect_uri: 'https://app.example/callback',
      tenant_id: 'site-1',
      scopes: 'instagram_business_basic,instagram_business_manage_messages',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.outstand.so/v1/social-networks/instagram/auth-url',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          redirect_uri: 'https://app.example/callback',
          tenant_id: 'site-1',
          scopes: 'instagram_business_basic,instagram_business_manage_messages',
        }),
      }),
    );
  });
});
