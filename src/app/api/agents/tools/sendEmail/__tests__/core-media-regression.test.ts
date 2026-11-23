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
jest.mock('@/lib/messaging/exact-email-content', () => ({ exactEmailContent: () => ({ text: 'Caption', htmlBody: '<p>Caption</p>' }) }));
jest.mock('@/lib/messaging/lead-merge-fields', () => ({ fetchSiteNameForMerge: jest.fn(async () => 'Site') }));
jest.mock('@/lib/services/zavu/client', () => ({ sendChannelMessage: jest.fn() }));

import { sendEmailCore } from '../core';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { AgentMailSendService } from '@/lib/services/email/AgentMailSendService';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { validateOutboundMedia } from '@/lib/services/channels/outbound-media';
import { resolveEmailMediaAttachment } from '@/lib/services/channels/email-media';
import { getSiteLicensedResources } from '@/lib/billing/licensed-resources';
import { sendChannelMessage } from '@/lib/services/zavu/client';

jest.mock('@/lib/billing/licensed-resources', () => ({
  ...jest.requireActual('@/lib/billing/licensed-resources'), getSiteLicensedResources: jest.fn(),
}));

const agent = AgentMailSendService.sendViaAgentMail as jest.Mock;
const smtp = EmailSendService.sendEmail as jest.Mock;
const from = supabaseAdmin.from as jest.Mock;
const params = { site_id: 'site', conversation_id: 'conversation', message_id: 'saved-message',
  email: 'recipient@example.test', subject: 'File', message: 'Caption', omit_signature: true };
const attachment = { filename: 'file.txt', content: Buffer.from('test attachment').toString('base64'), content_type: 'text/plain' };
const originalKey = process.env.AGENTMAIL_API_KEY;
const zavu = jest.mocked(sendChannelMessage);
const inventory = jest.mocked(getSiteLicensedResources);
const zavuEmail = { id: 'email-connection', type: 'email', status: 'connected', zavu_sender_id: 'zavu-sender', license_suspended: false };
let connections: Record<string, unknown>[];
let smtpEmail: string | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AGENTMAIL_API_KEY = randomBytes(24).toString('hex');
  connections = [];
  smtpEmail = 'smtp@example.test';
  inventory.mockReset();
  zavu.mockReset().mockResolvedValue({ message: { id: 'zavu-id', status: 'queued' } });
  from.mockImplementation(table => {
    if (table !== 'settings') throw new Error(`Unexpected mutation of ${table}`);
    return { select: () => ({ eq: () => ({ single: async () => ({ data: { channels: {
      agent_email: { status: 'active', username: 'sender', domain: 'example.test' }, email: { email: smtpEmail }, connections,
    } } }) }) }) };
  });
  (validateOutboundMedia as jest.Mock).mockResolvedValue(undefined);
  (resolveEmailMediaAttachment as jest.Mock).mockResolvedValue(attachment);
  agent.mockResolvedValue({ success: true, status: 'sent', email_id: 'provider-id', external_message_id: 'provider-id' });
  smtp.mockResolvedValue({ success: true, status: 'sent', email_id: 'smtp-id' });
});

function configureZavu(...eligibleInventory: Record<string, unknown>[]) {
  connections = [zavuEmail];
  inventory.mockResolvedValue({ channels: { connections: eligibleInventory }, social_media: [], effective_plan: 'engine' });
}

it('keeps AgentMail first even when Zavu is connected', async () => {
  configureZavu(zavuEmail);
  await expect(sendEmailCore(params)).resolves.toMatchObject({ external_message_id: 'provider-id' });
  expect(zavu).not.toHaveBeenCalled();
  expect(smtp).not.toHaveBeenCalled();
});

it('uses an eligible Zavu email before SMTP when AgentMail fails, even without SMTP configured', async () => {
  configureZavu({ ...zavuEmail, license_suspended: true }, { ...zavuEmail, metadata: { emailChannelActive: false } }, zavuEmail);
  smtpEmail = undefined;
  agent.mockRejectedValue(new Error('provider unavailable'));
  await expect(sendEmailCore(params)).resolves.toMatchObject({ success: true, status: 'queued', external_message_id: 'zavu-id' });
  expect(inventory).toHaveBeenCalledWith(params.site_id);
  expect(zavu).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', senderId: zavuEmail.zavu_sender_id,
    subject: params.subject, to: params.email, idempotencyKey: `send-email:${params.site_id}:${params.message_id}` }));
  expect(smtp).not.toHaveBeenCalled();
});

it('sends attachments through Zavu when AgentMail is not configured', async () => {
  delete process.env.AGENTMAIL_API_KEY;
  configureZavu(zavuEmail);
  await expect(sendEmailCore({ ...params, attachments: [attachment] })).resolves.toMatchObject({ external_message_id: 'zavu-id' });
  expect(zavu).toHaveBeenCalledWith(expect.objectContaining({ attachments: [attachment] }));
  expect(smtp).not.toHaveBeenCalled();
});

it('uses SMTP when no Zavu email connection is eligible', async () => {
  delete process.env.AGENTMAIL_API_KEY;
  configureZavu({ ...zavuEmail, enabled: false }, { ...zavuEmail, type: 'whatsapp' });
  await expect(sendEmailCore(params)).resolves.toMatchObject({ external_message_id: 'smtp-id' });
  expect(zavu).not.toHaveBeenCalled();
});

it('does not use SMTP after an unconfirmed Zavu attempt', async () => {
  delete process.env.AGENTMAIL_API_KEY;
  configureZavu(zavuEmail);
  zavu.mockRejectedValue(new Error('timeout after request'));
  await expect(sendEmailCore(params)).resolves.toMatchObject({ success: false, error: { code: 'ZAVU_EMAIL_FAILED' } });
  expect(smtp).not.toHaveBeenCalled();
});
afterAll(() => { if (originalKey === undefined) delete process.env.AGENTMAIL_API_KEY; else process.env.AGENTMAIL_API_KEY = originalKey; });

it('reuses the saved tracking ID and preserves AgentMail message metadata without a tracking copy', async () => {
  await expect(sendEmailCore(params)).resolves.toMatchObject({ success: true, email_id: 'provider-id' });
  expect(agent).toHaveBeenCalledWith(expect.objectContaining({ trackingId: params.message_id, preserveMessageMetadata: true }));
  expect(from).toHaveBeenCalledTimes(1);
  expect(smtp).not.toHaveBeenCalled();
});

it.each(['canonical media', 'base64 attachments'])('never falls back after an ambiguous AgentMail %s attempt', async kind => {
  configureZavu(zavuEmail);
  const extra = kind === 'canonical media' ? { message_type: 'document' as const, media_url: 'https://assets.example.test/file.txt' } : { attachments: [attachment] };
  if (kind === 'canonical media') (validateOutboundMedia as jest.Mock).mockResolvedValue({ content: { mediaUrl: extra.media_url } });
  agent.mockRejectedValue(new Error('timeout after provider accepted send'));
  await expect(sendEmailCore({ ...params, ...extra })).resolves.toMatchObject({ success: false, error: { code: 'AGENTMAIL_FAILED' } });
  expect(agent).toHaveBeenCalledTimes(1);
  expect(zavu).not.toHaveBeenCalled();
  expect(smtp).not.toHaveBeenCalled();
});

it('honors the no-fallback flag even when Zavu is connected', async () => {
  configureZavu(zavuEmail);
  agent.mockRejectedValue(new Error('timeout after request'));
  await expect(sendEmailCore({ ...params, disable_provider_fallback: true })).resolves.toMatchObject({
    success: false, error: { code: 'AGENTMAIL_FAILED' },
  });
  expect(zavu).not.toHaveBeenCalled();
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
