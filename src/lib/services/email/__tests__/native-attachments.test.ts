import { randomBytes } from 'node:crypto';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/channels/automation-send-guard', () => ({
  ...jest.requireActual('@/lib/services/channels/automation-send-guard'), assertAutomationSendAllowed: jest.fn(async () => undefined),
}));
jest.mock('nodemailer', () => ({ __esModule: true, default: { createTransport: jest.fn() } }));
jest.mock('../EmailConfigService', () => ({ EmailConfigService: { getEmailConfig: jest.fn() } }));
jest.mock('../SentEmailDuplicationService', () => ({ SentEmailDuplicationService: { generateEnvelopeBasedId: () => 'envelope' } }));
jest.mock('@/lib/integrations/agentmail/agentmail-service', () => ({ sendMessage: jest.fn() }));
jest.mock('@/lib/services/synced-objects/SyncedObjectsService', () => ({ SyncedObjectsService: { createObject: jest.fn() } }));
jest.mock('@/lib/services/tracking/EmailTrackingService', () => ({ EmailTrackingService: { injectTracking: (html: string) => html } }));
import nodemailer from 'nodemailer';
import { EmailSendService } from '../EmailSendService';
import { AgentMailSendService } from '../AgentMailSendService';
import { sendMessage } from '@/lib/integrations/agentmail/agentmail-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const bytes = Buffer.from('synthetic attachment bytes');
const attachments = [{ filename: 'invoice.pdf', content: bytes.toString('base64'), content_type: 'application/pdf' }];
const base = { site_id: 'site', email: 'recipient@example.test', subject: 'Invoice', message: 'Attached' };
beforeEach(() => {
  jest.clearAllMocks();
  const query: any = { select: () => query, eq: () => query, single: async () => ({ data: { name: 'Test' }, error: null }) };
  jest.mocked(supabaseAdmin.from).mockReturnValue(query);
});
test('SMTP sends real Buffer file bytes with filename/MIME, not an attachment URL', async () => {
  const sendMail = jest.fn(async () => ({ messageId: 'smtp' }));
  jest.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as any);
  const result = await EmailSendService.sendEmail({ ...base, from: 'Team', attachments,
    smtpConfig: { user: 'sender@example.test', password: randomBytes(24).toString('hex'), smtpHost: 'smtp.example.test', smtpPort: 587 } as any });
  expect(result.success).toBe(true);
  expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ attachments: [{ filename: 'invoice.pdf', content: bytes, contentType: 'application/pdf' }] }));
});
test('AgentMail forwards base64 file bytes with filename/MIME', async () => {
  jest.mocked(sendMessage).mockResolvedValue({ message_id: 'provider', thread_id: 'thread' });
  const result = await AgentMailSendService.sendViaAgentMail({ ...base, attachments,
    username: 'sender', domain: 'example.test', senderEmail: 'sender@example.test' });
  expect(result.success).toBe(true);
  expect(sendMessage).toHaveBeenCalledWith('sender@example.test', expect.objectContaining({ attachments }));
});
test('invalid attachment capability fails before provider dispatch', async () => {
  await expect(EmailSendService.sendEmail({ ...base, from: '', attachments: [{ filename: 'file', content: 'YQ==', path: '/etc/passwd' } as any] })).rejects.toThrow();
  expect(nodemailer.createTransport).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});