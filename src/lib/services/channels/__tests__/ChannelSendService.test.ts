import { ChannelSendService } from '../ChannelSendService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import * as zavuClient from '@/lib/services/zavu/client';

// Mock dependencias
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn()
  }
}));

jest.mock('@/lib/services/zavu/client', () => ({
  sendChannelMessage: jest.fn()
}));

describe('ChannelSendService', () => {
  const mockSiteId = 'test-site-id';
  const mockTo = '123456789';
  const mockMessage = 'Hello from Telegram';
  const mockSenderId = 'zavu-sender-123';
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should successfully send a telegram message when settings exist', async () => {
    // Setup mock supabase response
    (supabaseAdmin.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: [
            { type: 'telegram', zavu_sender_id: mockSenderId }
          ]
        }
      },
      error: null
    });

    // Setup mock Zavu response
    (zavuClient.sendChannelMessage as jest.Mock).mockResolvedValue({
      message: { id: 'msg_123' }
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'telegram',
      to: mockTo,
      message: mockMessage
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg_123');
    
    // Verify DB query
    expect(supabaseAdmin.from).toHaveBeenCalledWith('settings');
    expect(supabaseAdmin.select).toHaveBeenCalledWith('channels');
    expect(supabaseAdmin.eq).toHaveBeenCalledWith('site_id', mockSiteId);
    
    // Verify Zavu call with correct senderId
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith({
      to: mockTo,
      text: mockMessage,
      channel: 'telegram',
      senderId: mockSenderId,
      subject: undefined
    });
  });

  it('should return error if no sender is configured for the channel', async () => {
    (supabaseAdmin.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: []
        }
      },
      error: null
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'messenger',
      to: mockTo,
      message: mockMessage
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No sender configured');
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('should return error if site settings fetch fails', async () => {
    (supabaseAdmin.single as jest.Mock).mockResolvedValue({
      data: null,
      error: new Error('DB Error')
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'telegram',
      to: mockTo,
      message: mockMessage
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Settings not found');
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('should return error if required params are missing', async () => {
    const result = await ChannelSendService.sendMessage({
      site_id: '',
      channel: 'telegram',
      to: mockTo,
      message: mockMessage
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('should resolve whatsapp sender and send with subject omitted', async () => {
    (supabaseAdmin.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: [{ type: 'whatsapp', zavu_sender_id: mockSenderId }],
        },
      },
      error: null,
    });

    (zavuClient.sendChannelMessage as jest.Mock).mockResolvedValue({
      message: { id: 'wa_1' },
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'whatsapp',
      to: '+5215550001111',
      message: mockMessage,
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('wa_1');
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith({
      to: '+5215550001111',
      text: mockMessage,
      channel: 'whatsapp',
      senderId: mockSenderId,
      subject: undefined,
    });
  });

  it('should resolve email sender and pass subject', async () => {
    (supabaseAdmin.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: [{ type: 'email', zavu_sender_id: mockSenderId }],
        },
      },
      error: null,
    });

    (zavuClient.sendChannelMessage as jest.Mock).mockResolvedValue({
      message: { id: 'em_1' },
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'email',
      to: 'user@example.com',
      message: mockMessage,
      subject: 'Re: Your inquiry',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('em_1');
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith({
      to: 'user@example.com',
      text: mockMessage,
      channel: 'email',
      senderId: mockSenderId,
      subject: 'Re: Your inquiry',
    });
  });

  it('should return error if whatsapp sender is missing', async () => {
    (supabaseAdmin.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: [{ type: 'telegram', zavu_sender_id: mockSenderId }],
        },
      },
      error: null,
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'whatsapp',
      to: '+5215550001111',
      message: mockMessage,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No sender configured');
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('should return error if zavu API throws', async () => {
    (supabaseAdmin.single as jest.Mock).mockResolvedValue({
      data: {
        channels: { connections: [{ type: 'telegram', zavu_sender_id: mockSenderId }] }
      },
      error: null
    });

    (zavuClient.sendChannelMessage as jest.Mock).mockRejectedValue(new Error('Zavu API failed'));

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'telegram',
      to: mockTo,
      message: mockMessage
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Zavu API failed');
  });
});