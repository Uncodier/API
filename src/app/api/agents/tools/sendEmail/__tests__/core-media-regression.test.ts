import { randomBytes } from 'node:crypto';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/database/lead-db', () => ({ getLeadById: jest.fn() }));
jest.mock('@/lib/services/channels/automation-send-guard', () => ({
  assertAutomationSendAllowed: jest.fn(), AutomationSendSuppressed: class extends Error {}, automationSkippedResult: jest.fn(),
}));
jest.mock('@/lib/i18n/email-locale', () => ({ resolveEmailLocale: jest.fn(), buildComposeLanguageInstruction: jest.fn() }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: { isValidEmail: jest.fn(() => true), sendEmail: jest.fn() } }));
jest.mock('@/lib/services/email/AgentMailSendService', () => ({ AgentMailSendService: { sendViaAgentMail: jest.fn() } }));
jest.mock('@/lib/services/email/EmailSignatureService', () => ({ EmailSignatureService: { generateAgentSignature: jest.fn() } }));
jest.mock('@/lib/services/synced-objects/SyncedObjectsService', () => ({ SyncedObjectsService: { createObject: jest.fn() } }));
jest.mock('@/lib/services/channels/outbound-media', () => ({ validateOutboundMedia: jest.fn() }));
jest.mock('@/lib/services/channels/saved-outbound-media', () => ({ requireSavedOutboundMedia: jest.fn() }));
jest.mock('@/lib/services/channels/native-media-delivery', () => ({ dispatchNativeMedia: jest.fn(async (_input: unknown, _provider: string, send: () => Promise<unknown>) => send()) }));
jest.mock('@/lib/services/channels/email-media', () => ({ resolveEmailMediaAttachment: jest.fn() }));
jest.mock('@/lib/services/email/email-send-rate-limit', () => ({ acquireEmailSendPermit: jest.fn(async () => ({ acquired: true })), releaseEmailSendPermit: jest.fn() }));

import { sendEmailCore } from '../core';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { AgentMailSendService } from '@/lib/services/email/AgentMailSendService';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { validateOutboundMedia } from '@/lib/services/channels/outbound-media';
import { resolveEmailMediaAttachment } from '@/lib/services/channels/email-media';

const agent = AgentMailSendService.sendViaAgentMail as jest.Mock;
const smtp = EmailSendService.sendEmail as jest.Mock;
const from = supabaseAdmin.from as jest.Mock;
const params = { site_id: 'site', conversation_id: 'conversation', message_id: 'saved-message',
  email: 'recipient@example.test', subject: 'File', message: 'Caption', omit_signature: true };
const attachment = { filename: 'file.txt', content: Buffer.from('test attachment').toString('base64'), content_type: 'text/plain' };
const originalKey = process.env.AGENTMAIL_API_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AGENTMAIL_API_KEY = randomBytes(24).toString('hex');
  from.mockImplementation(table => {
    if (table !== 'settings') throw new Error(`Unexpected mutation of ${table}`);
    return { select: () => ({ eq: () => ({ single: async () => ({ data: { channels: {
      agent_email: { status: 'active', username: 'sender', domain: 'example.test' }, email: { email: 'smtp@example.test' },
    } } }) }) }) };
  });
  (validateOutboundMedia as jest.Mock).mockResolvedValue(undefined);
  (resolveEmailMediaAttachment as jest.Mock).mockResolvedValue(attachment);
  agent.mockResolvedValue({ success: true, status: 'sent', email_id: 'provider-id', external_message_id: 'provider-id' });
  smtp.mockResolvedValue({ success: true, status: 'sent', email_id: 'smtp-id' });
});
afterAll(() => { if (originalKey === undefined) delete process.env.AGENTMAIL_API_KEY; else process.env.AGENTMAIL_API_KEY = originalKey; });

it('reuses the saved tracking ID and preserves AgentMail message metadata without a tracking copy', async () => {
  await expect(sendEmailCore(params)).resolves.toMatchObject({ success: true, email_id: 'provider-id' });
  expect(agent).toHaveBeenCalledWith(expect.objectContaining({ trackingId: params.message_id, preserveMessageMetadata: true }));
  expect(from).toHaveBeenCalledTimes(1);
  expect(smtp).not.toHaveBeenCalled();
});

it.each(['canonical media', 'base64 attachments'])('never falls back after an ambiguous AgentMail %s attempt', async kind => {
  const extra = kind === 'canonical media' ? { message_type: 'document' as const, media_url: 'https://assets.example.test/file.txt' } : { attachments: [attachment] };
  if (kind === 'canonical media') (validateOutboundMedia as jest.Mock).mockResolvedValue({ content: { mediaUrl: extra.media_url } });
  agent.mockRejectedValue(new Error('timeout after provider accepted send'));
  await expect(sendEmailCore({ ...params, ...extra })).resolves.toMatchObject({ success: false, error: { code: 'AGENTMAIL_FAILED' } });
  expect(agent).toHaveBeenCalledTimes(1);
  expect(smtp).not.toHaveBeenCalled();
});

it('still permits legacy text fallback without overwriting saved metadata', async () => {
  agent.mockRejectedValue(new Error('provider unavailable'));
  await expect(sendEmailCore(params)).resolves.toMatchObject({ success: true, external_message_id: 'smtp-id' });
  expect(smtp).toHaveBeenCalledWith(expect.objectContaining({ trackingId: params.message_id }));
  expect(from).toHaveBeenCalledTimes(1);
});

it('reuses the saved ID on direct SMTP sends', async () => {
  delete process.env.AGENTMAIL_API_KEY;
  await sendEmailCore({ ...params, attachments: [attachment] });
  expect(agent).not.toHaveBeenCalled();
  expect(smtp).toHaveBeenCalledWith(expect.objectContaining({ trackingId: params.message_id, attachments: [attachment] }));
  expect(from).toHaveBeenCalledTimes(1);
});
