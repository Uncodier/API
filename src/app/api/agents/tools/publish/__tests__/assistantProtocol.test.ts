import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getLeadById } from '@/lib/database/lead-db';
import { sendEmailCore } from '../../sendEmail/route';
import { publishTool } from '../assistantProtocol';

jest.mock('../../content/create/core', () => ({
  createContentCore: jest.fn(),
}));
jest.mock('../../content/update/route', () => ({
  updateContentCore: jest.fn(),
}));
jest.mock('@/lib/integrations/outstand/client', () => ({
  getOutstandClient: jest.fn(),
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
});
