import { supabaseAdmin } from '@/lib/database/supabase-client';
import { deliverExplicitAudio, markAudioPreflightFailed } from '../explicit-audio-delivery';
import { deliverZavuTemplate } from '@/lib/services/whatsapp/zavu-template-delivery';
import { synthesizeSpeech } from '@/lib/services/ai/tts-service';
import { getZavuTemplate, sendZavuTemplate } from '@/lib/services/zavu/templates';
import { AutomationSendSuppressed } from '../automation-send-guard';
import { createHash } from 'node:crypto';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: jest.fn(), from: jest.fn(), storage: { from: jest.fn() } } }));
jest.mock('../long-reply-audio', () => ({ stripMarkdownForSpeech: (text: string) => text }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: { PRICING: { AUDIO_GENERATION_MINUTE: 1 }, validateCredits: jest.fn(async () => true), deductCredits: jest.fn() } }));
jest.mock('@/lib/services/ai/tts-service', () => ({ validateSpeechOptions: jest.fn(() => ({})), synthesizeSpeech: jest.fn() }));
jest.mock('@/lib/billing/licensed-resources', () => ({ requireLicensedChannel: jest.fn() }));
jest.mock('@/lib/services/whatsapp/template-language', () => ({ loadSiteTemplateLanguage: jest.fn(async () => 'en') }));
jest.mock('@/lib/services/zavu/templates', () => ({ createZavuTemplate: jest.fn(), getZavuTemplate: jest.fn(), submitZavuTemplate: jest.fn(), sendZavuTemplate: jest.fn() }));

let row: any;
let conversation: any;
const params = { siteId: 'site', conversationId: 'conversation', messageId: 'message', text: 'Hello',
  recipient: 'recipient', sender: 'sender', channel: 'telegram' };
beforeEach(() => {
  jest.clearAllMocks();
  conversation = { id: 'conversation', automation_paused_until: null, last_human_reply_at: null };
  row = { id: 'message', role: 'assistant', content: 'Hello', created_at: '2026-01-01T00:00:00Z',
    custom_data: { response_format: 'audio', source: 'telegram' } };
  (supabaseAdmin.schema as jest.Mock).mockReturnValue(supabaseAdmin);
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => {
    let update: any; const filters: any[] = [];
    const execute = async () => {
      if (table === 'conversations') return { data: structuredClone(conversation) };
      if (!update) return { data: structuredClone(row) };
      if (filters.some(([key, value]) => key === 'custom_data' && JSON.stringify(row.custom_data) !== value)) return { data: null };
      row.custom_data = update.custom_data; return { data: { id: row.id } };
    };
    const q: any = { select: () => q, eq: (key: string, value: any) => { filters.push([key, value]); return q; },
      is: () => q, update: (value: any) => { update = value; return q; }, maybeSingle: execute,
      then: (resolve: any, reject: any) => execute().then(resolve, reject) };
    return q;
  });
  (supabaseAdmin.storage.from as jest.Mock).mockReturnValue({ upload: jest.fn(async () => ({})),
    getPublicUrl: () => ({ data: { publicUrl: 'https://assets.example.test/audio.mp3' } }) });
});

test('human reply during TTS suppresses dispatch and leaves terminal marker rather than failed/unknown', async () => {
  jest.mocked(synthesizeSpeech).mockImplementation(async () => {
    conversation.last_human_reply_at = '2026-01-01T01:00:00Z';
    return { audio: Buffer.from('synthetic'), mimeType: 'audio/mpeg' } as any;
  });
  const dispatch = jest.fn();
  await expect(deliverExplicitAudio({ ...params, dispatch })).rejects.toBeInstanceOf(AutomationSendSuppressed);
  await markAudioPreflightFailed(params);
  expect(dispatch).not.toHaveBeenCalled();
  expect(row.custom_data).toMatchObject({ status: 'skipped', automation_skipped: true, automation_skip_reason: 'stale_automatic_reply' });
  await expect(deliverExplicitAudio({ ...params, dispatch })).rejects.toBeInstanceOf(AutomationSendSuppressed);
  expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
});

test('human pause while pending template approval is polled suppresses send permanently', async () => {
  const input = { ...params, connectionId: 'connection', senderId: 'sender' };
  row.custom_data.template_delivery = { key: createHash('sha256').update(JSON.stringify(['Hello', 'recipient', 'sender', 'connection'])).digest('hex'),
    state: 'pending', template_id: 'template', name: 'saved', body: 'Hello', language: 'en',
    submitted_sender_id: 'sender', started_at: new Date().toISOString() };
  jest.mocked(getZavuTemplate).mockImplementation(async () => {
    conversation.automation_paused_until = '2999-01-01T00:00:00Z';
    return { id: 'template', name: 'saved', body: 'Hello', language: 'en', status: 'approved' } as any;
  });
  await expect(deliverZavuTemplate(input)).rejects.toBeInstanceOf(AutomationSendSuppressed);
  expect(sendZavuTemplate).not.toHaveBeenCalled();
  expect(row.custom_data).toMatchObject({ status: 'skipped', automation_skipped: true, automation_skip_reason: 'agent_snoozed' });
  conversation.automation_paused_until = null;
  await expect(deliverZavuTemplate(input)).rejects.toBeInstanceOf(AutomationSendSuppressed);
  expect(getZavuTemplate).toHaveBeenCalledTimes(1);
});