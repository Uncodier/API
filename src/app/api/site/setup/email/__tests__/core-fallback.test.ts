import { randomUUID } from 'node:crypto';
const mockAgentSend = jest.fn();
const mockSmtpSend = jest.fn();
const mockRelease = jest.fn();
const settings = { channels: { agent_email: { status: 'active', username: 'offline', domain: 'example.test' }, email: { email: 'sender@example.test' } } };
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: settings, error: null }) }) }) }) } }));
jest.mock('@/lib/database/lead-db', () => ({ getLeadById: jest.fn() }));
jest.mock('@/lib/messaging/lead-merge-fields', () => ({}));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: { isValidEmail: () => true, sendEmail: (...args: unknown[]) => mockSmtpSend(...args) } }));
jest.mock('@/lib/services/email/AgentMailSendService', () => ({ AgentMailSendService: { sendViaAgentMail: (...args: unknown[]) => mockAgentSend(...args) } }));
jest.mock('@/lib/services/email/EmailSignatureService', () => ({ EmailSignatureService: {} }));
jest.mock('@/lib/services/synced-objects/SyncedObjectsService', () => ({ SyncedObjectsService: { createObject: jest.fn() } }));
jest.mock('@/lib/services/email/email-send-rate-limit', () => ({ acquireEmailSendPermit: async () => ({ acquired: true }), releaseEmailSendPermit: (...args: unknown[]) => mockRelease(...args) }));
jest.mock('@/lib/i18n/email-locale', () => ({ resolveEmailLocale: async () => 'en', buildComposeLanguageInstruction: () => 'English' }));
import { sendEmailCore } from '@/app/api/agents/tools/sendEmail/core';
beforeEach(() => {
  jest.clearAllMocks();
  process.env.AGENTMAIL_API_KEY = randomUUID();
  mockAgentSend.mockRejectedValue(new Error('Provider accepted but confirmation was lost'));
  mockSmtpSend.mockResolvedValue({ success: true, status: 'sent', email_id: 'smtp-id' });
});
const input = { site_id: randomUUID(), email: 'owner@example.test', subject: 'Setup', message: 'Ready', omit_signature: true };
it('actual core suppresses SMTP fallback after ambiguous AgentMail acceptance for setup claims', async () => {
  expect(await sendEmailCore({ ...input, disable_provider_fallback: true })).toMatchObject({ success: false, error: { code: 'AGENTMAIL_FAILED' } });
  expect(mockAgentSend).toHaveBeenCalledTimes(1);
  expect(mockSmtpSend).not.toHaveBeenCalled();
  expect(mockRelease).toHaveBeenCalledTimes(1);
});
it('preserves existing fallback behavior for unrelated core callers', async () => {
  expect(await sendEmailCore(input)).toMatchObject({ success: true, status: 'sent', email_id: 'smtp-id' });
  expect(mockSmtpSend).toHaveBeenCalledTimes(1);
});