import { AudioRoutingError, resolveAudioRouting } from '../audio-routing';
import { getSiteLicensedResources } from '@/lib/billing/licensed-resources';

const mockFrom = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) } }));
jest.mock('@/lib/billing/licensed-resources', () => ({
  ...jest.requireActual('@/lib/billing/licensed-resources'), getSiteLicensedResources: jest.fn(),
}));

const input = { siteId: 'site-a', conversationId: 'conversation-a', channel: 'telegram' };
const connection = (id: string, extra = {}) => ({ id, type: 'telegram', status: 'connected',
  license_suspended: false, zavu_sender_id: `sender-${id}`, ...extra });

describe('authoritative audio routing', () => {
  let conversation: any;
  let history: any[];
  let channels: any;
  let historyError: any;
  let filters: Array<[string, unknown]>;
  beforeEach(() => {
    jest.clearAllMocks();
    conversation = { channel: 'telegram', custom_data: {} };
    history = [];
    historyError = null;
    filters = [];
    channels = { connections: [connection('first'), connection('second')] };
    (getSiteLicensedResources as jest.Mock).mockImplementation(async () => ({ channels }));
    mockFrom.mockImplementation((table: string) => {
      const q: any = {
        select: jest.fn(() => q), eq: jest.fn((k, v) => { filters.push([k, v]); return q; }),
        order: jest.fn(() => q), maybeSingle: async () => ({ data: conversation, error: null }),
        limit: async () => ({ data: table === 'messages' ? history : null, error: historyError }),
      };
      return q;
    });
  });

  it('uses the conversation binding even when it is not the first connection', async () => {
    conversation.custom_data.connection_id = 'second';
    await expect(resolveAudioRouting(input)).resolves.toEqual({ kind: 'zavu', connectionId: 'second', senderId: 'sender-second' });
    expect(mockFrom).not.toHaveBeenCalledWith('messages');
    expect(filters).toContainEqual(['site_id', input.siteId]);
  });

  it('uses unique inbound scope when Zavu did not bind the conversation', async () => {
    history = [{ custom_data: { connection_id: 'second' } }, { custom_data: {} }, { custom_data: { connection_id: 'second' } }];
    await expect(resolveAudioRouting(input)).resolves.toMatchObject({ connectionId: 'second' });
    expect(filters).toEqual(expect.arrayContaining([
      ['conversation_id', input.conversationId], ['conversations.site_id', input.siteId], ['role', 'user'],
    ]));
  });

  it('a saved message remains pinned even when conversation routing has changed', async () => {
    conversation.custom_data.connection_id = 'first';
    await expect(resolveAudioRouting({ ...input, connectionId: 'second' })).resolves.toMatchObject({ connectionId: 'second' });
  });

  it('rejects an unbound multi-account conversation rather than defaulting to first', async () => {
    await expect(resolveAudioRouting(input)).rejects.toThrow(AudioRoutingError);
  });

  it('accepts a sole configured licensed sender when no binding exists', async () => {
    channels.connections = [connection('second')];
    await expect(resolveAudioRouting(input)).resolves.toMatchObject({ connectionId: 'second' });
  });

  it('rejects mixed inbound accounts instead of using the latest or first', async () => {
    history = [{ custom_data: { connection_id: 'second' } }, { custom_data: { connection_id: 'first' } }];
    await expect(resolveAudioRouting(input)).rejects.toThrow(/ambiguous/);
  });

  it.each([null, '', ' second ', 42, {}, 'deleted', 'legacy:whatsapp'])('rejects invalid/stale explicit binding %j', async id => {
    await expect(resolveAudioRouting({ ...input, connectionId: id })).rejects.toThrow(AudioRoutingError);
  });

  it.each(['conversation', 'inbound'])('does not silently recover from stale %s metadata', async location => {
    if (location === 'conversation') conversation.custom_data.connection_id = 'deleted';
    else history = [{ custom_data: { connection_id: 'deleted' } }];
    channels.connections = [connection('first')];
    await expect(resolveAudioRouting(input)).rejects.toThrow(AudioRoutingError);
  });

  it.each([
    { status: 'disconnected' }, { enabled: false }, { license_suspended: true },
    { _license: { manually_disabled: true } }, { type: 'messenger' }, { zavu_sender_id: '' },
  ])('rejects unavailable explicitly selected connection %j without fallback', async override => {
    channels.connections[1] = connection('second', override);
    await expect(resolveAudioRouting({ ...input, connectionId: 'second' })).rejects.toThrow(AudioRoutingError);
  });

  it.each([undefined, 'second'])('rejects duplicate connection identifiers (binding %s)', async connectionId => {
    channels.connections = [connection('second'), connection('second', { status: 'disconnected' })];
    await expect(resolveAudioRouting({ ...input, connectionId })).rejects.toThrow(AudioRoutingError);
  });

  it.each(['lookup-error', 'truncated'])('fails closed on %s history', async mode => {
    if (mode === 'lookup-error') historyError = new Error('offline');
    else history = Array.from({ length: 1000 }, () => ({ custom_data: { connection_id: 'second' } }));
    await expect(resolveAudioRouting(input)).rejects.toThrow(/history/);
  });

  it.each([null, { channel: 'messenger' }])('rejects a missing/foreign or wrong-channel conversation %j', async data => {
    conversation = data;
    await expect(resolveAudioRouting(input)).rejects.toThrow(AudioRoutingError);
    expect(getSiteLicensedResources).not.toHaveBeenCalled();
  });

  describe('legacy Twilio separation', () => {
    const legacyInput = { ...input, channel: 'whatsapp', allowLegacyWhatsApp: true };
    beforeEach(() => {
      conversation.channel = 'whatsapp';
      channels.whatsapp = { status: 'active', account_sid: 'test-account', existingNumber: '+15555550123' };
      channels.connections = [connection('zavu-wa', { type: 'whatsapp' })];
    });
    it('preserves non-channel legacy WhatsApp without defaulting to a Zavu account', async () => {
      await expect(resolveAudioRouting(legacyInput)).resolves.toEqual({ kind: 'legacy-whatsapp', connectionId: 'legacy:whatsapp' });
    });
    it('keeps a saved legacy id out of generic channel Zavu sends', async () => {
      await expect(resolveAudioRouting({ ...legacyInput, connectionId: 'legacy:whatsapp', allowLegacyWhatsApp: false })).rejects.toThrow(/dedicated adapter/);
    });
    it('uses inbound Zavu binding despite a legacy config being present', async () => {
      history = [{ custom_data: { connection_id: 'zavu-wa' } }];
      await expect(resolveAudioRouting(legacyInput)).resolves.toMatchObject({ kind: 'zavu', connectionId: 'zavu-wa' });
    });
    it('does not route channel-delivery WhatsApp to legacy Twilio', async () => {
      conversation.custom_data = { channel_delivery: true, connection_id: 'legacy:whatsapp' };
      await expect(resolveAudioRouting(legacyInput)).rejects.toThrow(/dedicated adapter/);
    });
    it('rejects disabled legacy config instead of switching to a Zavu sender', async () => {
      channels.whatsapp.license_suspended = true;
      await expect(resolveAudioRouting(legacyInput)).rejects.toThrow(/unavailable/);
    });
  });
});