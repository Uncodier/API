jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { schema: jest.fn(() => ({ from: () => ({ select: () => ({ eq: () => ({
    maybeSingle: async () => ({ data: { default_locale: 'de' }, error: null }),
  }) }) }) })) },
}));
import { getLeadInfo } from '../agent-data';
import { isInternalServiceRequest } from '@/lib/security/request-rate-limit';

jest.mock('@/lib/services/customer-support-audio', () => ({ supportAudioContext: jest.fn() }));
jest.mock('@/lib/services/customer-support-audio-history', () => ({ supportHistoricalAudioContext: jest.fn() }));
jest.mock('@/lib/services/conversation-service', () => ({
  ConversationService: {
    getConversationHistory: jest.fn(),
    formatConversationHistoryForContext: jest.fn(),
  },
}));
jest.mock('../agent-data', () => ({ getLeadInfo: jest.fn(), isValidUUID: jest.fn(() => true) }));
jest.mock('@/app/api/agents/customerSupport/lead-record', () => ({ appendLeadRecordToContext: jest.fn(async (context: string) => context) }));
jest.mock('@/lib/promotions/context', () => ({
  appendActivePromotionsToContext: jest.fn(async (context: string) => context),
}));
jest.mock('@/lib/services/workflow-robot/channel-message', () => ({ getCompletedChannelMessageGuidance: jest.fn() }));
jest.mock('@/lib/security/request-rate-limit', () => ({ isInternalServiceRequest: jest.fn(() => false) }));
jest.mock('@/app/api/agents/customerSupport/support-policies', () => ({ getCustomerSupportPolicies: () => '' }));

import { buildSupportContext } from '../context';
import { supportAudioContext } from '@/lib/services/customer-support-audio';
import { supportHistoricalAudioContext } from '@/lib/services/customer-support-audio-history';
import { ConversationService } from '@/lib/services/conversation-service';

const currentAudio = jest.mocked(supportAudioContext);
const historicalAudio = jest.mocked(supportHistoricalAudioContext);
const history = jest.mocked(ConversationService.getConversationHistory);
const formatHistory = jest.mocked(ConversationService.formatConversationHistoryForContext);
const input = {
  request: {}, message: '[audio]', effectiveSiteId: 'site-current',
  effectiveConversationId: '00000000-0000-4000-8000-000000000001',
  origin_message_id: 'message-current', effectiveOrigin: 'whatsapp',
};
const url = 'https://files.example.test/current.ogg';

describe('buildSupportContext audio wiring (offline)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(isInternalServiceRequest).mockReturnValue(false);
    currentAudio.mockResolvedValue('');
    historicalAudio.mockResolvedValue('');
    history.mockResolvedValue([]);
    formatHistory.mockImplementation(messages => messages.map(m => `${m.role}: ${m.content}`).join('\n'));
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Live requests forbidden'); });
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('passes normalized current attachments and effective scope to transcription and surfaces its result', async () => {
    currentAudio.mockResolvedValue('\nAudio transcript: Please change my delivery address.\n');
    const context = await buildSupportContext({ ...input, site_id: 'wrong-site', attachments: [
      { mediaUrl: url, contentType: 'audio/ogg', fileName: 'note.ogg', messageType: 'audio', secret: 'discard' },
      { url }, { url: 'file:///tmp/note.ogg' }, null,
    ] });
    expect(currentAudio).toHaveBeenCalledTimes(1);
    expect(currentAudio).toHaveBeenCalledWith({
      attachments: [{ url, mimeType: 'audio/ogg', name: 'note.ogg', type: 'audio' }],
      siteId: input.effectiveSiteId, conversationId: input.effectiveConversationId, messageId: input.origin_message_id,
    });
    expect(context).toContain('Audio transcript: Please change my delivery address.');
    expect(context).not.toContain('no downloadable audio reference');
    expect(historicalAudio).not.toHaveBeenCalled();
  });

  it('routes historical attachments only to the read-only helper and surfaces the cached transcript in history', async () => {
    const attachments = [{ url: 'https://files.example.test/old.ogg', type: 'audio', mimeType: 'audio/ogg' }];
    history.mockResolvedValue([{ role: 'user', content: 'Earlier voice note', attachments }] as any);
    historicalAudio.mockResolvedValue('\nHistorical audio transcript: My order number is 42.\n');
    const context = await buildSupportContext({ ...input, message: 'Any update?', attachments: [{ url, type: 'audio' }] });
    expect(history).toHaveBeenCalledWith(input.effectiveConversationId);
    expect(historicalAudio).toHaveBeenCalledTimes(1);
    expect(historicalAudio).toHaveBeenCalledWith({ siteId: input.effectiveSiteId, attachments });
    expect(currentAudio).toHaveBeenCalledTimes(1);
    expect(currentAudio.mock.calls[0][0].attachments).toEqual([
      { url, type: 'audio', mimeType: undefined, name: undefined },
    ]);
    expect(formatHistory).toHaveBeenCalledWith([expect.objectContaining({
      attachments, content: 'Earlier voice note\nHistorical audio transcript: My order number is 42.\n',
    })]);
    expect(context).toContain('Conversation History:\nuser: Earlier voice note\nHistorical audio transcript: My order number is 42.');
  });

  it.each(['[audio]', '[VOICE]', '[voice_note]'])('explicitly reports missing audio for %s', async message => {
    const context = await buildSupportContext({ ...input, message, attachments: [{ url: 'file:///tmp/audio' }] });
    expect(currentAudio).toHaveBeenCalledWith(expect.objectContaining({ attachments: [], siteId: input.effectiveSiteId }));
    expect(context).toContain('Audio transcription unavailable: no downloadable audio reference. Ask for a resend or text; never invent its contents.');
  });

  it.each(['unknown', 'internal', 'fr-FR,fr;q=0.9'])('ignores HTTP language %s while preserving customer language evidence', async acceptLanguage => {
    currentAudio.mockResolvedValue('\nAudio transcript: Por favor, responde en español.\n');
    history.mockResolvedValue([{ role: 'user', content: 'Hola, necesito ayuda' }] as any);
    const context = await buildSupportContext({ ...input, acceptLanguage });
    expect(context).not.toContain(`\nLanguage: ${acceptLanguage}`);
    expect(context).toContain('Por favor, responde en español.');
    expect(context).toContain('user: Hola, necesito ayuda');
    expect(context).toContain('1. Explicitly requested customer language');
    expect(context).toContain('fallback language: "de"; source: site language');
  });

  it('reuses the loaded lead language as fallback below customer evidence', async () => {
    jest.mocked(getLeadInfo).mockResolvedValueOnce({ id: 'lead-1', language: 'fr' });
    const context = await buildSupportContext({ ...input, effectiveLeadId: 'lead-1', message: 'Please reply in Japanese' });
    expect(getLeadInfo).toHaveBeenCalledTimes(1);
    expect(context).toContain('Please reply in Japanese');
    expect(context).toContain('fallback language: "fr"; source: lead preference');
    expect(context).toContain('written response and spoken/audio response');
  });

  it('does not label ordinary text as missing audio', async () => {
    const context = await buildSupportContext({ ...input, message: 'Hello' });
    expect(context).not.toContain('Audio transcription unavailable');
  });

  it('adds contextual format choice and explicit override without requesting synthesis', async () => {
    const context = await buildSupportContext({ ...input, message: 'Hello' });
    expect(context).toContain('Choose message.response_format="text" or "audio"');
    expect(context).toContain('Default safely to text');
    expect(context).toContain('Never generate speech, call TTS, or send/dispatch');
    const explicit = await buildSupportContext({ ...input, response_format: 'audio' });
    expect(explicit).toContain('explicitly requires response_format="audio"');
  });

  it('includes the actual inbound number even when the loaded CRM lead has another phone', async () => {
    jest.mocked(isInternalServiceRequest).mockReturnValue(true);
    jest.mocked(getLeadInfo).mockResolvedValueOnce({ id: 'lead-1', phone: '+12025550199' });
    const context = await buildSupportContext({ ...input, message: 'Use this number', effectiveLeadId: 'lead-1',
      custom_data: { source: 'zavu_inbound_message', channel: 'whatsapp', zavu_from: 'whatsapp:+12025550123',
        zavu_sender_id: 'business-id' },
    });
    expect(context).toContain('"customer_reply_identifier": "whatsapp:+12025550123"');
    expect(context).toContain('Phone: +12025550199');
    expect(context).toContain('CRM contact details below may differ');
  });

  it.each([false, true])('does not trust provider metadata from external/browser requests (browser=%s)', async browser => {
    jest.mocked(isInternalServiceRequest).mockReturnValue(browser);
    const context = await buildSupportContext({ ...input, message: 'Hello', browserIdentity: browser ? {} : undefined,
      custom_data: { source: 'zavu_inbound_message', channel: 'whatsapp', zavu_from: 'spoofed-identity' },
    });
    expect(context).not.toContain('spoofed-identity');
    expect(context).toContain('unknown / not provided');
  });
});
