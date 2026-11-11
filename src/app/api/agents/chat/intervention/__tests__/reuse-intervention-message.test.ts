const mockFrom = jest.fn();
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async () => undefined) }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: mockFrom } }));
import { reuseInterventionMessage } from '../reuse-intervention-message';
import { resolveAudioRouting } from '@/lib/services/channels/audio-routing';
jest.mock('@/lib/services/channels/audio-routing', () => ({ resolveAudioRouting: jest.fn() }));

const messageId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';

describe('intervention retry ownership and atomic claim', () => {
  let customData: Record<string, unknown>;
  let readData: any;
  let filters: Array<[string, unknown]>;
  let claimed: boolean;
  let updates: number;
  let updatedMetadata: Record<string, unknown> | undefined;
  beforeEach(() => {
    (resolveAudioRouting as jest.Mock).mockReset();
    customData = { status: 'failed', command_status: 'failed', error_message: 'Old error' };
    readData = { id: messageId, conversation_id: conversationId, content: 'Hello', custom_data: customData };
    filters = [];
    claimed = true;
    updates = 0;
    updatedMetadata = undefined;
    mockFrom.mockImplementation(() => {
      let writing = false;
      const q: any = {
        select: () => q,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return q; },
        single: async () => ({ data: readData, error: null }),
        update: (payload: any) => { writing = true; updates++; updatedMetadata = payload.custom_data; expect(payload.custom_data.error_message).toBeUndefined(); return q; },
        maybeSingle: async () => ({ data: writing && claimed ? { id: messageId } : null, error: null }),
      };
      return q;
    });
  });

  it('retains saved canonical media when retry omits it', async () => {
    const mediaInput = { message_type: 'document', media_url: 'https://assets.example.test/saved.pdf', mime_type: 'application/pdf' };
    Object.assign(customData, mediaInput);
    expect(await reuseInterventionMessage(messageId, conversationId, userId, 'Hello', { channel: 'telegram' }))
      .toMatchObject({ mediaInput });
    expect(updatedMetadata).toMatchObject(mediaInput);
  });

  it('refuses replacing saved canonical media before retry claim', async () => {
    Object.assign(customData, { message_type: 'document', media_url: 'https://assets.example.test/saved.pdf' });
    expect(await reuseInterventionMessage(messageId, conversationId, userId, 'Hello', { channel: 'telegram',
      mediaInput: { message_type: 'document', media_url: 'https://assets.example.test/other.pdf' } })).toBeNull();
    expect(updates).toBe(0);
  });

  it('claims the unchanged failed message and scopes both reads and writes to its author', async () => {
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello')).resolves.toMatchObject({ interventionMessageId: messageId });
    expect(filters).toContainEqual(['custom_data', JSON.stringify(customData)]);
    expect(filters.filter(([key]) => key === 'user_id')).toEqual([['user_id', userId], ['user_id', userId]]);
  });

  it('allows the legacy pending status with a failed command marker', async () => {
    customData.status = 'pending';
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello')).resolves.not.toBeNull();
  });

  it('rejects a concurrent claim without starting another send', async () => {
    claimed = false;
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello')).resolves.toBeNull();
  });
  it.each(['creating', 'submitting', 'pending', 'ready', 'dispatching', 'sent', 'rejected', 'unknown'])('does not let manual retry take over template state %s', async state => {
    Object.assign(customData, { response_format: 'audio', template_delivery: { state, template_id: 'template' } });
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello', { channel: 'whatsapp' })).resolves.toBeNull();
    expect(updates).toBe(0);
    expect(resolveAudioRouting).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'sent' }, { status: 'delivered' }, { status: 'placement_unknown' },
    { status: 'queued' }, { status: 'running' }, { command_status: 'success' },
    { provider_call_id: 'call' }, { call_status: 'queued' }, { call_status: 'placement_unknown' },
  ])('never retries advanced delivery state %j', async (extra) => {
    Object.assign(customData, extra);
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello')).resolves.toBeNull();
    expect(updates).toBe(0);
  });

  it('rejects changed content or a missing author-scoped row', async () => {
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Different')).resolves.toBeNull();
    readData = null;
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello')).resolves.toBeNull();
    expect(updates).toBe(0);
  });

  it.each(['text', 'audio'] as const)('preserves saved %s when the retry omits its choice', async (responseFormat) => {
    customData.response_format = responseFormat;
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello', { channel: 'telegram' }))
      .resolves.toMatchObject({ responseFormat });
    expect(updatedMetadata?.response_format).toBe(responseFormat);
  });

  it('revalidates and preserves the pinned sender on audio retry without a new insert', async () => {
    Object.assign(customData, { response_format: 'audio', connection_id: 'original-second' });
    (resolveAudioRouting as jest.Mock).mockResolvedValue({ kind: 'zavu', connectionId: 'original-second', senderId: 'sender' });
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello', {
      channel: 'telegram', siteId: 'site-a',
    })).resolves.toMatchObject({ channelDelivery: true });
    expect(resolveAudioRouting).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'original-second' }));
    expect(updatedMetadata?.connection_id).toBe('original-second');
    expect(filters).toContainEqual(['custom_data', JSON.stringify(customData)]);
  });

  it('does not claim an audio retry when its pinned connection is stale', async () => {
    Object.assign(customData, { response_format: 'audio', connection_id: 'removed' });
    (resolveAudioRouting as jest.Mock).mockRejectedValue(new Error('Audio sender unavailable'));
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello', {
      channel: 'telegram', siteId: 'site-a',
    })).rejects.toThrow('Audio sender unavailable');
    expect(updates).toBe(0);
  });

  it.each([
    ['audio', 'text'], ['text', 'audio'], [undefined, 'audio'], [undefined, 'text'],
  ] as const)('rejects changing saved %s into %s', async (saved, requested) => {
    if (saved) customData.response_format = saved;
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello', {
      responseFormat: requested, channel: 'whatsapp',
    })).resolves.toBeNull();
    expect(updates).toBe(0);
  });

  it.each(['email', 'voice', 'web', undefined])('rejects saved audio on authoritative channel %s', async (channel) => {
    customData.response_format = 'audio';
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello', { channel })).resolves.toBeNull();
    expect(updates).toBe(0);
  });

  it.each(['preparing', 'dispatching', 'unknown', 'sent', 'preparation_failed', undefined])(
    'does not reset audio receipt %s even when generic status says failed', async (state) => {
      Object.assign(customData, { response_format: 'audio', audio_delivery: { state } });
      await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello', { channel: 'whatsapp' })).resolves.toBeNull();
      expect(updates).toBe(0);
    },
  );

  it('allows an undispatched prepared audio receipt to resume without replacing it', async () => {
    Object.assign(customData, { response_format: 'audio', audio_delivery: { state: 'ready', key: 'saved-key' } });
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello', {
      responseFormat: 'audio', channel: 'messenger',
    })).resolves.toMatchObject({ responseFormat: 'audio' });
    expect(updatedMetadata?.audio_delivery).toEqual({ state: 'ready', key: 'saved-key' });
  });

  it('rejects an oversized saved audio retry even when the request omits its choice', async () => {
    customData.response_format = 'audio';
    readData.content = 'a'.repeat(4001);
    await expect(reuseInterventionMessage(messageId, conversationId, userId, readData.content, { channel: 'whatsapp' })).resolves.toBeNull();
    expect(updates).toBe(0);
  });

  it.each([null, 'video', 1])('rejects invalid saved format %s', async (format) => {
    customData.response_format = format;
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello', { channel: 'whatsapp' })).resolves.toBeNull();
    expect(updates).toBe(0);
  });
});