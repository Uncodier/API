const mockFrom = jest.fn();
const mockPlace = jest.fn();
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { from: mockFrom } }));
jest.mock('../voice-call-client', () => ({ placeVoiceCall: mockPlace }));
jest.mock('../contact-client', () => ({ setVoiceCallContactContext: jest.fn(), clearVoiceCallContactContext: jest.fn() }));
jest.mock('../voice-agent-context', () => ({ ensureVoiceContactMetadataEnabled: jest.fn(), requireVoiceExecutionContextSupport: jest.fn() }));
jest.mock('../voice-follow-up-context', () => ({
  buildVoiceFollowUpContext: jest.fn(async () => ({ context: 'Follow-up', sources: {} })),
}));

import { placeTrackedVoiceCall } from '../voice-call-service';
import type { VoiceCallConsentRecord } from '../voice-call-consent';
import { requireVoiceExecutionContextSupport } from '../voice-agent-context';

describe('tracked voice placement outcomes', () => {
  let customData: Record<string, any>;
  let delivery: any;
  let preferences: VoiceCallConsentRecord;
  let failAcceptedWrite: boolean;
  let raceMessageWrite: boolean;
  const input = { siteId: 'site', messageId: 'message', greeting: 'Hello', to: '+14155550100' };

  beforeEach(() => {
    jest.clearAllMocks();
    customData = { status: 'pending', command_status: 'pending' };
    delivery = null;
    preferences = {};
    failAcceptedWrite = false;
    raceMessageWrite = false;
    mockPlace.mockResolvedValue({ id: 'call', status: 'queued', to: input.to });
    mockFrom.mockImplementation((table: string) => {
      let update: any;
      const filters: Record<string, unknown> = {};
      const execute = async () => {
        if (update) {
          if (table === 'messages') {
            if (failAcceptedWrite && update.custom_data.provider_call_id) return { data: null, error: new Error('DB unavailable') };
            if (raceMessageWrite && 'custom_data' in filters) {
              customData = { ...customData, provider_call_id: 'call', call_status: 'completed', status: 'sent', command_status: 'success' };
              return { data: null, error: null };
            }
            customData = update.custom_data;
          } else if (table === 'voice_call_deliveries' && (!filters.status || filters.status === delivery?.status)) {
            delivery = { ...delivery, ...update };
          }
          return { data: { id: 'message' }, error: null };
        }
        const data = table === 'messages' ? { id: 'message', lead_id: 'lead', conversation_id: 'conversation', custom_data: customData }
          : table === 'voice_call_deliveries' ? delivery
          : table === 'leads' ? { phone: input.to, ...preferences }
          : { channels: { connections: [{ type: 'voice', status: 'connected', zavu_sender_id: 'sender' }] } };
        return { data, error: null };
      };
      const q: any = {
        select: () => q,
        eq: (key: string, value: unknown) => { filters[key] = value; return q; },
        maybeSingle: execute,
        update: (payload: any) => { update = payload; return q; },
        insert: async (payload: any) => { delivery = payload; return { error: null }; },
        then: (resolve: any, reject: any) => execute().then(resolve, reject),
      };
      return q;
    });
  });

  it.each([
    {},
    { voice_call_consent_status: 'unknown', voice_call_consent_at: null },
    { voice_call_consent_status: 'granted' },
    { voice_call_consent_status: 'granted', voice_call_consent_at: 'invalid' },
  ])('accepts and deduplicates calls without explicit consent: %j', async (record) => {
    preferences = record;
    await expect(placeTrackedVoiceCall(input)).resolves.toMatchObject({ call: { id: 'call' } });
    expect(customData).toMatchObject({ status: 'sent', command_status: 'success', provider_call_id: 'call' });
    preferences = { voice_call_consent_status: 'revoked' };
    await expect(placeTrackedVoiceCall(input)).resolves.toMatchObject({ duplicate: true, call: { id: 'call' } });
    expect(mockPlace).toHaveBeenCalledTimes(1);
  });

  it.each([
    { do_not_call: true, voice_call_consent_status: 'granted', voice_call_consent_at: '2026-09-21T12:00:00Z' },
    { voice_call_consent_status: 'revoked' },
    { voice_call_consent_status: 'denied' },
  ])('persists explicit opt-out rejection before placing a call: %j', async (record) => {
    preferences = record;
    await expect(placeTrackedVoiceCall(input)).rejects.toMatchObject({ deliveryStatus: 'failed', status: 403 });
    expect(customData).toMatchObject({ status: 'failed', command_status: 'failed', call_status: 'failed' });
    expect(mockPlace).not.toHaveBeenCalled();
    expect(delivery).toBeNull();
  });

  it.each([{ to: '' }, { greeting: 'x'.repeat(1001) }, { greeting: ' ' }])('persists input preflight failure %j', async (extra) => {
    await expect(placeTrackedVoiceCall({ ...input, ...extra })).rejects.toMatchObject({ deliveryStatus: 'failed' });
    expect(customData.command_status).toBe('failed');
    expect(mockPlace).not.toHaveBeenCalled();
  });

  it('recovers durable publish intent after queued execution and does not speak internal instructions', async () => {
    const siteId = '11111111-1111-4111-8111-111111111111';
    const sourceConversation = '22222222-2222-4222-8222-222222222222';
    customData.tool_execution_context = {
      version: 1, site_id: siteId, intent: 'Confirm Monday appointment at five',
      background: 'Check availability; previous booking failed.',
      source: { tool: 'publish', conversation_id: sourceConversation },
    };
    await placeTrackedVoiceCall({ ...input, siteId, greeting: undefined });
    expect(customData.tool_execution_context.intent).toBe('Confirm Monday appointment at five');
    expect(customData.voice_objective).toBe('Confirm Monday appointment at five');
    expect(mockPlace.mock.calls[0][0]).not.toHaveProperty('greeting');
    expect(mockPlace.mock.calls[0][0].metadata).toMatchObject({ objective: 'Confirm Monday appointment at five', conversationId: 'conversation' });
  });

  it('rejects an instruction-only call without a valid objective before contacting the provider', async () => {
    await expect(placeTrackedVoiceCall({ ...input, greeting: undefined })).rejects.toMatchObject({ status: 400 });
    expect(mockPlace).not.toHaveBeenCalled();
  });

  it('does not dial an instruction-only call until context support has been synchronized', async () => {
    jest.mocked(requireVoiceExecutionContextSupport).mockRejectedValueOnce(Object.assign(new Error('Re-sync required'), { status: 409 }));
    await expect(placeTrackedVoiceCall({ ...input, greeting: undefined, objective: 'Confirm Monday' })).rejects.toMatchObject({ status: 409 });
    expect(mockPlace).not.toHaveBeenCalled();
    expect(delivery).toBeNull();
  });

  it.each([undefined, 408, 409, 425, 429, 500])('keeps ambiguous provider outcome pending (HTTP %s)', async (status) => {
    mockPlace.mockRejectedValue(Object.assign(new Error('Provider unavailable'), { status }));
    await expect(placeTrackedVoiceCall(input)).rejects.toMatchObject({ deliveryStatus: 'placement_unknown' });
    expect(customData).toMatchObject({ status: 'placement_unknown', command_status: 'pending', call_status: 'placement_unknown' });
    expect(delivery.status).toBe('placement_unknown');
    await expect(placeTrackedVoiceCall(input)).rejects.toMatchObject({ deliveryStatus: 'placement_unknown' });
    expect(mockPlace).toHaveBeenCalledTimes(1);
  });

  it('marks explicit provider rejection failed', async () => {
    mockPlace.mockRejectedValue(Object.assign(new Error('Invalid request'), { status: 400 }));
    await expect(placeTrackedVoiceCall(input)).rejects.toMatchObject({ deliveryStatus: 'failed' });
    expect(customData).toMatchObject({ status: 'failed', command_status: 'failed' });
  });

  it('returns known call acceptance despite a message write failure', async () => {
    failAcceptedWrite = true;
    await expect(placeTrackedVoiceCall(input)).resolves.toMatchObject({ call: { id: 'call' } });
    expect(delivery.zavu_call_id).toBe('call');
    expect(customData.status).not.toBe('failed');
  });

  it('does not regress a terminal delivery webhook when provider placement returns late', async () => {
    mockPlace.mockImplementation(async () => {
      delivery = { ...delivery, zavu_call_id: 'call', status: 'completed' };
      customData = { ...customData, provider_call_id: 'call', call_status: 'completed', status: 'sent' };
      return { id: 'call', status: 'queued', to: input.to };
    });
    await expect(placeTrackedVoiceCall(input)).resolves.toMatchObject({ call: { id: 'call' } });
    expect(delivery.status).toBe('completed');
    expect(customData).toMatchObject({ call_status: 'completed', command_status: 'success' });
  });

  it('does not overwrite a terminal callback racing the placement message update', async () => {
    raceMessageWrite = true;
    await expect(placeTrackedVoiceCall(input)).resolves.toMatchObject({ call: { id: 'call' } });
    expect(customData).toMatchObject({ status: 'sent', command_status: 'success', call_status: 'completed' });
  });

  it('does not label a preflight rejection retryable if its state write races a callback', async () => {
    preferences = { voice_call_consent_status: 'revoked' };
    raceMessageWrite = true;
    await expect(placeTrackedVoiceCall(input)).rejects.toMatchObject({ deliveryStatus: 'placement_unknown' });
    expect(customData.call_status).toBe('completed');
    expect(mockPlace).not.toHaveBeenCalled();
  });
});