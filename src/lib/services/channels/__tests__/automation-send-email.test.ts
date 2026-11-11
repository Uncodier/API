import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { assertAutomationSendAllowed, AutomationSendSuppressed } from '../automation-send-guard';
import nodemailer from 'nodemailer';

jest.mock('../automation-send-guard', () => ({ ...jest.requireActual('../automation-send-guard'), assertAutomationSendAllowed: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(() => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { name: 'Test' } }) }) }) })) } }));
jest.mock('@/lib/services/email/EmailConfigService', () => ({ EmailConfigService: { getEmailConfig: jest.fn() } }));
jest.mock('@/lib/services/email/SentEmailDuplicationService', () => ({ SentEmailDuplicationService: { generateEnvelopeBasedId: jest.fn() } }));
jest.mock('@/lib/services/tracking/EmailTrackingService', () => ({ EmailTrackingService: { injectTracking: (text: string) => text } }));
jest.mock('nodemailer', () => ({ __esModule: true, default: { createTransport: jest.fn() } }));

test('SMTP preparation forwards original persisted identity and returns skipped before sendMail', async () => {
  const sendMail = jest.fn();
  jest.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as any);
  jest.mocked(EmailConfigService.getEmailConfig).mockResolvedValue({ user: 'sender@example.test', smtpHost: 'smtp.example.test', smtpPort: 587 } as any);
  jest.mocked(assertAutomationSendAllowed).mockRejectedValue(new AutomationSendSuppressed('agent_snoozed'));
  const identity = { site_id: 'site', conversation_id: 'conversation', message_id: 'saved', message: 'Original {{name}}' };
  const result = await EmailSendService.sendEmail({ email: 'recipient@example.test', from: 'Team', subject: 'Reply',
    site_id: 'site', conversation_id: 'conversation', message: 'Original resolved name', automationIdentity: identity });
  expect(assertAutomationSendAllowed).toHaveBeenCalledWith(identity);
  expect(sendMail).not.toHaveBeenCalled();
  expect(result).toEqual({ success: true, status: 'skipped', skipped: true, delivered: false, reason: 'agent_snoozed' });
});