import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getLeadById } from '@/lib/database/lead-db';
import { sendEmailCore } from '../../sendEmail/route';
import { sendBulkMessagesTool } from '../../sendBulkMessages/assistantProtocol';
import { publishTool } from '../assistantProtocol';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { authorizeOutstandConversation } from '@/lib/integrations/outstand/conversation-access';
import { recordOutstandMessage } from '@/lib/integrations/outstand/inbox-sync';

jest.mock('../../content/create/core', () => ({
  createContentCore: jest.fn(),
}));
jest.mock('../../content/update/route', () => ({
  updateContentCore: jest.fn(),
}));
jest.mock('@/lib/integrations/outstand/client', () => ({
  getOutstandClient: jest.fn(),
}));
jest.mock('@/lib/integrations/outstand/conversation-access', () => ({
  authorizeOutstandConversation: jest.fn(),
}));
jest.mock('@/lib/integrations/outstand/inbox-sync', () => ({
  recordOutstandMessage: jest.fn(),
}));
jest.mock('../../sendBulkMessages/assistantProtocol', () => ({
  sendBulkMessagesTool: jest.fn(),
}));
jest.mock('../../sendEmail/route', () => ({
  sendEmailCore: jest.fn(),
}));
jest.mock('@/lib/services/whatsapp/WhatsAppSendService', () => ({
  WhatsAppSendService: { sendMessage: jest.fn() },
}));
jest.mock('@/lib/database/lead-db', () => ({
  getLeadById: jest.fn(),
}));

const siteId = '00000000-0000-4000-8000-000000000001';
const leadId = '00000000-0000-4000-8000-000000000002';
const mockedGetLeadById = getLeadById as jest.MockedFunction<typeof getLeadById>;
const mockedSendEmailCore = sendEmailCore as jest.MockedFunction<typeof sendEmailCore>;
const mockedSendBulkMessagesTool =
  sendBulkMessagesTool as jest.MockedFunction<typeof sendBulkMessagesTool>;
const mockedGetOutstandClient =
  getOutstandClient as jest.MockedFunction<typeof getOutstandClient>;
const mockedAuthorizeOutstandConversation =
  authorizeOutstandConversation as jest.MockedFunction<typeof authorizeOutstandConversation>;
const mockedRecordOutstandMessage =
  recordOutstandMessage as jest.MockedFunction<typeof recordOutstandMessage>;
const bulkExecuteMock = jest.fn(async (_args: unknown) => ({ success: true }));
const sendConversationMessageMock = jest.fn();
const getMediaMock = jest.fn();

describe('publish test delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetLeadById.mockResolvedValue({
      id: leadId,
      site_id: siteId,
      name: 'Sergio Prado',
      email: 'lead@example.com',
      phone: '+15551234567',
    } as Awaited<ReturnType<typeof getLeadById>>);
    mockedSendEmailCore.mockResolvedValue({ success: true, status: 'sent' });
    mockedSendBulkMessagesTool.mockReturnValue({
      execute: bulkExecuteMock,
    } as unknown as ReturnType<typeof sendBulkMessagesTool>);
    mockedGetOutstandClient.mockReturnValue({
      sendConversationMessage: sendConversationMessageMock,
      getMedia: getMediaMock,
    } as unknown as ReturnType<typeof getOutstandClient>);
    sendConversationMessageMock.mockResolvedValue({
      success: true,
      message: { id: 'outstand-message-1', status: 'pending' },
    } as never);
    mockedAuthorizeOutstandConversation.mockResolvedValue({
      success: true,
      conversation: { id: 'outstand-conversation-1' },
    } as never);
    mockedRecordOutstandMessage.mockResolvedValue();
  });

  it('uses test_lead_id for personalization while honoring an explicit recipient', async () => {
    const result = await publishTool(siteId, undefined, 'instance-id').execute({
      is_test: true,
      test_lead_id: leadId,
      test_recipient: 'preview@example.com',
      channel: 'email',
      audience_email_mode: 'newsletter',
      subject: 'Hello {{lead.first_name}}',
      text: 'Welcome {{lead.name}}',
      placeholders_when_unresolved: 'strip_tokens',
    });

    expect(result.success).toBe(true);
    expect(mockedGetLeadById).toHaveBeenCalledWith(leadId);
    expect(mockedSendEmailCore).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'preview@example.com',
        lead_id: leadId,
        subject: '[TEST] Hello {{lead.first_name}}',
        message: 'Welcome {{lead.name}}',
        placeholder_policy: 'strip_tokens',
      }),
    );
  });

  it('uses the lead email when no explicit recipient is provided', async () => {
    await publishTool(siteId).execute({
      is_test: true,
      test_lead_id: leadId,
      channel: 'email',
      subject: 'Test',
      text: 'Hello',
    });

    expect(mockedSendEmailCore).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'lead@example.com',
        lead_id: leadId,
      }),
    );
  });

  it('refuses to send merge tokens without a lead identity', async () => {
    const result = await publishTool(siteId).execute({
      is_test: true,
      test_recipient: 'preview@example.com',
      channel: 'email',
      subject: 'Test',
      text: 'Hello {{lead.name}}',
    });

    expect(result).toMatchObject({
      success: false,
      audience: {
        success: false,
        error: 'A valid test_lead_id is required when a test message contains merge fields',
      },
    });
    expect(mockedSendEmailCore).not.toHaveBeenCalled();
  });

  it('rejects a lead belonging to another site', async () => {
    mockedGetLeadById.mockResolvedValueOnce({
      id: leadId,
      site_id: '00000000-0000-4000-8000-000000000099',
      name: 'Other Site Lead',
      email: 'other@example.com',
    } as Awaited<ReturnType<typeof getLeadById>>);

    const result = await publishTool(siteId).execute({
      is_test: true,
      test_lead_id: leadId,
      channel: 'email',
      subject: 'Test',
      text: 'Hello',
    });

    expect(result.success).toBe(false);
    expect(mockedSendEmailCore).not.toHaveBeenCalled();
  });

  it('passes the conversational Voice mode to the bulk sender', async () => {
    const result = await publishTool(siteId).execute({
      audience_id: '00000000-0000-4000-8000-000000000003',
      channel: 'voice',
      voice_mode: 'agent_call',
      text: 'Hello, this is Acme calling about your appointment.',
      objective: 'Confirm the appointment',
      additional_context: 'Offer a morning or afternoon slot.',
    });

    expect(result.success).toBe(true);
    expect(bulkExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'voice',
      voice_mode: 'agent_call',
      objective: 'Confirm the appointment',
      additional_context: 'Offer a morning or afternoon slot.',
    }));
  });

  it('sends a scheduled Instagram DM through the Conversations API', async () => {
    const scheduledAt = new Date(Date.now() + 60_000).toISOString();

    const result = await publishTool(siteId).execute({
      text: 'Your order is ready.',
      instagram_dm: {
        conversation_id: 'outstand-conversation-1',
        media_urls: ['https://cdn.example.com/order.jpg'],
        scheduled_at: scheduledAt,
      },
    });

    expect(result.success).toBe(true);
    expect(result.actions_attempted).toContain('instagram_dm');
    expect(sendConversationMessageMock).toHaveBeenCalledWith(
      'outstand-conversation-1',
      {
        content: 'Your order is ready.',
        media_urls: ['https://cdn.example.com/order.jpg'],
        scheduled_at: scheduledAt,
      },
    );
  });

  it('resolves uploaded assets to public URLs for an Instagram DM', async () => {
    getMediaMock.mockResolvedValueOnce({
      success: true,
      data: { url: 'https://media.outstand.so/image.jpg' },
    } as never);

    await publishTool(siteId).execute({
      assets: ['media-1'],
      instagram_dm: { conversation_id: 'outstand-conversation-1' },
    });

    expect(sendConversationMessageMock).toHaveBeenCalledWith(
      'outstand-conversation-1',
      { media_urls: ['https://media.outstand.so/image.jpg'] },
    );
  });

  it('uses urls as Instagram DM text content', async () => {
    const result = await publishTool(siteId).execute({
      urls: ['https://example.com/order'],
      instagram_dm: { conversation_id: 'outstand-conversation-1' },
    });

    expect(result.success).toBe(true);
    expect(sendConversationMessageMock).toHaveBeenCalledWith(
      'outstand-conversation-1',
      { content: 'https://example.com/order' },
    );
  });

  it('rejects an Instagram DM scheduled in the past', async () => {
    const result = await publishTool(siteId).execute({
      text: 'Too late',
      instagram_dm: {
        conversation_id: 'outstand-conversation-1',
        scheduled_at: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('future ISO 8601');
    expect(sendConversationMessageMock).not.toHaveBeenCalled();
  });
});
