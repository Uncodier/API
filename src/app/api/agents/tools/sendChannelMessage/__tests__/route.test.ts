import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { ChannelSendService } from '@/lib/services/channels/ChannelSendService';
import { bindLocalOutstandMessage } from '@/lib/integrations/outstand/inbox-sync';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canAccessSite } from '@/lib/security/site-access';
import { POST } from '../route';

jest.mock('@/lib/services/channels/ChannelSendService', () => ({
  ChannelSendService: { sendMessage: jest.fn() },
}));
jest.mock('@/lib/integrations/outstand/inbox-sync', () => ({
  bindLocalOutstandMessage: jest.fn(),
}));
jest.mock('@/lib/services/zavu/voice-call-service', () => ({
  assertVoiceCallAllowed: jest.fn(),
}));
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock('@/lib/security/site-access', () => ({
  canAccessSite: jest.fn(),
}));

describe('sendChannelMessage Outstand reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (ChannelSendService.sendMessage as jest.Mock).mockResolvedValue({
      success: true,
      messageId: 'outstand-message-1',
    } as never);
    (bindLocalOutstandMessage as jest.Mock).mockResolvedValue(undefined as never);
    (canAccessSite as jest.Mock).mockResolvedValue(true as never);

    const query: Record<string, jest.Mock> = {};
    query.select = jest.fn(() => query);
    query.eq = jest.fn(() => query);
    query.maybeSingle = jest.fn().mockResolvedValue({
      data: {
        custom_data: {
          outstand_conversation_id: 'outstand-conversation-1',
        },
      },
      error: null,
    } as never);
    (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  });

  it('keeps Instagram delivery pending and binds the provider id to the saved row', async () => {
    const response = await POST(new NextRequest(
      'https://api.example.com/api/agents/tools/sendChannelMessage',
      {
        method: 'POST',
        body: JSON.stringify({
          channel: 'instagram',
          to: 'instagram-user',
          message: 'Hello',
          site_id: '00000000-0000-4000-8000-000000000001',
          conversation_id: '00000000-0000-4000-8000-000000000002',
          message_id: '00000000-0000-4000-8000-000000000003',
        }),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      delivered: false,
      status: 'pending',
    });
    expect(bindLocalOutstandMessage).toHaveBeenCalledWith({
      localMessageId: '00000000-0000-4000-8000-000000000003',
      localConversationId: '00000000-0000-4000-8000-000000000002',
      outstandConversationId: 'outstand-conversation-1',
      outstandMessageId: 'outstand-message-1',
    });
  });

  it('rejects a caller without access to the selected site', async () => {
    (canAccessSite as jest.Mock).mockResolvedValue(false as never);

    const response = await POST(new NextRequest(
      'https://api.example.com/api/agents/tools/sendChannelMessage',
      {
        method: 'POST',
        body: JSON.stringify({
          channel: 'instagram',
          to: 'instagram-user',
          message: 'Hello',
          site_id: '00000000-0000-4000-8000-000000000001',
        }),
      },
    ));

    expect(response.status).toBe(403);
    expect(ChannelSendService.sendMessage).not.toHaveBeenCalled();
  });
});
