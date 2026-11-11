import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { ChannelSendService } from '@/lib/services/channels/ChannelSendService';
import { bindLocalOutstandMessage } from '@/lib/integrations/outstand/inbox-sync';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canAccessSite } from '@/lib/security/site-access';
import { POST } from '../route';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async () => undefined) }));

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
      provider: 'outstand',
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

  it.each(['image', 'video', 'audio', 'document'] as const)('accepts and exactly forwards a media-only %s request', async message_type => {
    const payload = { channel: 'telegram', to: 'chat-id', site_id: 'site', message_type,
      media_url: 'https://assets.example.test/media', mime_type: message_type === 'document' ? 'application/pdf' : `${message_type}/example` };
    const response = await POST(new NextRequest('https://api.example.test/send', { method: 'POST', body: JSON.stringify(payload) }));
    expect(response.status).toBe(200);
    expect(ChannelSendService.sendMessage).toHaveBeenCalledWith({ ...payload, message: undefined, subject: undefined,
      agent_id: undefined, conversation_id: undefined, lead_id: undefined, message_id: undefined, response_format: undefined });
    expect(assertSafeRemoteUrl).toHaveBeenCalledWith(payload.media_url);
  });

  it.each([
    { channel: 'sms', message_type: 'image', media_url: 'https://assets.example.test/a.jpg' },
    { channel: 'voice', message_type: 'video', media_url: 'https://assets.example.test/a.mp4' },
    { channel: 'instagram', message_type: 'document', media_url: 'https://assets.example.test/a.pdf' },
    { channel: 'facebook', message_type: 'image', media_url: 'https://assets.example.test/a.jpg' },
    { channel: 'telegram', message_type: 'image' },
    { channel: 'telegram', media_url: 'https://assets.example.test/a.jpg' },
    { channel: 'telegram', message_type: 'image', media_url: 'http://assets.example.test/a.jpg' },
    { channel: 'telegram', message_type: 'image', media_url: 'https://assets.example.test/a.jpg', response_format: 'audio' },
  ])('rejects unsupported/malformed media without calling the service: %j', async media => {
    const response = await POST(new NextRequest('https://api.example.test/send', { method: 'POST',
      body: JSON.stringify({ to: 'recipient', site_id: 'site', message: 'Never downgrade', ...media }) }));
    expect(response.status).toBe(400);
    expect(ChannelSendService.sendMessage).not.toHaveBeenCalled();
    expect(bindLocalOutstandMessage).not.toHaveBeenCalled();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('checks site access before resolving media URLs or dispatching', async () => {
    (canAccessSite as jest.Mock).mockResolvedValue(false as never);
    const response = await POST(new NextRequest('https://api.example.test/send', { method: 'POST',
      body: JSON.stringify({ channel: 'telegram', to: 'chat', site_id: 'site', message_type: 'image', media_url: 'https://assets.example.test/a.jpg' }) }));
    expect(response.status).toBe(403);
    expect(assertSafeRemoteUrl).not.toHaveBeenCalled();
    expect(ChannelSendService.sendMessage).not.toHaveBeenCalled();
  });

  it('does not write sent metadata when a media send is suppressed', async () => {
    (ChannelSendService.sendMessage as jest.Mock).mockResolvedValue({ success: true, skipped: true, reason: 'agent_snoozed', delivered: false } as never);
    const response = await POST(new NextRequest('https://api.example.test/send', { method: 'POST', body: JSON.stringify({
      channel: 'telegram', to: 'chat', site_id: 'site', message_id: 'saved', conversation_id: 'conversation',
      message_type: 'image', media_url: 'https://assets.example.test/a.jpg',
    }) }));
    expect(await response.json()).toMatchObject({ skipped: true, status: 'skipped', delivered: false });
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
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
  it('does not bind a Zavu Instagram receipt to stale Outstand conversation metadata', async () => {
    (ChannelSendService.sendMessage as jest.Mock).mockResolvedValue({ success: true, messageId: 'zavu-provider', provider: 'zavu' } as never);
    const response = await POST(new NextRequest('https://api.example.test/send', { method: 'POST', body: JSON.stringify({
      channel: 'instagram', to: 'user', site_id: 'site', message: '', message_id: 'saved', conversation_id: 'conversation',
      message_type: 'image', media_url: 'https://media.example.test/photo.png',
    }) }));
    expect(await response.json()).toMatchObject({ success: true, status: 'sent', delivered: true, messageId: 'zavu-provider' });
    expect(bindLocalOutstandMessage).not.toHaveBeenCalled();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it.each(['whatsapp', 'telegram', 'messenger'])('forwards %s audio without rewriting its durable receipt', async channel => {
    (ChannelSendService.sendMessage as jest.Mock).mockResolvedValue({ success: true, messageId: 'provider', provider: 'zavu' } as never);
    const response = await POST(new NextRequest('https://api.example.test/send', {
      method: 'POST', body: JSON.stringify({ channel, to: 'recipient', message: 'Hello', site_id: 'site',
        conversation_id: 'conversation', message_id: 'saved', response_format: 'audio' }),
    }));
    expect(response.status).toBe(200);
    expect(ChannelSendService.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel, response_format: 'audio', message_id: 'saved', conversation_id: 'conversation',
    }));
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('rejects unsupported audio before dispatch', async () => {
    const response = await POST(new NextRequest('https://api.example.test/send', {
      method: 'POST', body: JSON.stringify({ channel: 'instagram', to: 'recipient', message: 'Hello',
        site_id: 'site', response_format: 'audio' }),
    }));
    expect(response.status).toBe(400);
    expect(ChannelSendService.sendMessage).not.toHaveBeenCalled();
  });
  it.each([true, false])('reports template lifecycle without an audio success or metadata rewrite (pending: %s)', async pending => {
    const templateDelivery = { success: true, template_pending: pending, template_used: !pending,
      status: pending ? 'template_pending' : 'sent', delivery_format: 'template', requested_response_format: 'audio',
      template_id: 'template', message_id: pending ? 'saved' : 'provider', ...(pending ? {} : { messageId: 'provider' }) };
    (ChannelSendService.sendMessage as jest.Mock).mockResolvedValue({ success: true, templateDelivery } as never);
    const response = await POST(new NextRequest('https://api.example.test/send', {
      method: 'POST', body: JSON.stringify({ channel: 'whatsapp', to: '+15555550100', message: 'Hola',
        site_id: 'site', response_format: 'audio', message_id: 'saved', conversation_id: 'conversation' }),
    }));
    expect(response.status).toBe(pending ? 202 : 200);
    expect(await response.json()).toMatchObject({ ...templateDelivery, delivered: false });
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });
});
