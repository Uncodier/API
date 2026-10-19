const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockPlace = jest.fn();
const mockSetContactContext = jest.fn();
const mockClearContactContext = jest.fn();
const mockGetSenderAgent = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc } }));
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { from: mockFrom } }));
jest.mock('../voice-call-client', () => ({ placeVoiceCall: mockPlace }));
jest.mock('../contact-client', () => ({
  setVoiceCallContactContext: mockSetContactContext,
  clearVoiceCallContactContext: mockClearContactContext,
}));
jest.mock('../agent-client', () => ({ getSenderAgent: mockGetSenderAgent, updateAgent: jest.fn() }));
jest.mock('../voice-follow-up-context', () => ({
  buildVoiceFollowUpContext: jest.fn(async () => ({ context: 'Follow-up', sources: {} })),
}));

import { placeTrackedVoiceCall } from '../voice-call-service';
import { isChannelActiveStatus, requireLicensedChannel, VOICE_ACTIVE_STATUSES } from '@/lib/billing/licensed-resources';

type Connection = Record<string, unknown>;
const input = { siteId: 'site-1', messageId: 'message-1', greeting: 'Hello', to: '+14155550100' };
const exact = { selectedConnectionId: 'chosen', selectedSenderId: 'chosen-sender' };
const voice = (status: string): Connection => ({
  id: 'chosen', type: 'voice', status, zavu_sender_id: 'chosen-sender', enabled: true, license_suspended: false,
});

describe('licensed Voice status contract at real placement boundaries', () => {
  let connections: Connection[];
  let customData: Record<string, unknown>;
  let delivery: Record<string, unknown> | null;
  let filters: unknown[][];

  beforeEach(() => {
    jest.clearAllMocks();
    connections = [voice('connected')];
    customData = { status: 'pending', command_status: 'pending' };
    delivery = null;
    filters = [];
    mockRpc.mockImplementation(() => ({ abortSignal: async () => ({ error: null, data: {
      effective_plan: 'foundry', social_media: [], channels: { connections },
    } }) }));
    mockPlace.mockResolvedValue({ id: 'call-1', status: 'queued', to: input.to });
    mockGetSenderAgent.mockResolvedValue({ id: 'agent-1', includeContactMetadata: true });
    mockSetContactContext.mockResolvedValue(undefined);
    mockClearContactContext.mockResolvedValue(undefined);
    mockFrom.mockImplementation((table: string) => {
      if (!['messages', 'leads', 'voice_call_deliveries'].includes(table)) throw new Error(`Unexpected table: ${table}`);
      let update: Record<string, any> | undefined;
      const execute = async () => {
        if (update) {
          if (table === 'messages') customData = update.custom_data;
          else if (table === 'voice_call_deliveries') delivery = { ...delivery, ...update };
          return { data: { id: input.messageId }, error: null };
        }
        return { error: null, data: table === 'messages'
          ? { id: input.messageId, conversation_id: 'conversation-1', lead_id: 'lead-1', custom_data: customData }
          : table === 'leads' ? { phone: input.to, do_not_call: false, voice_call_consent_status: 'granted',
            voice_call_consent_at: '2026-09-21T12:00:00Z' } : delivery };
      };
      const q: any = {
        select: () => q,
        eq: (key: string, value: unknown) => { filters.push([table, key, value]); return q; },
        maybeSingle: execute,
        update: (payload: Record<string, unknown>) => { update = payload; return q; },
        insert: async (payload: Record<string, unknown>) => { delivery = payload; return { error: null }; },
        then: (resolve: any, reject: any) => execute().then(resolve, reject),
      };
      return q;
    });
  });

  it.each(VOICE_ACTIVE_STATUSES)('legacy placement accepts licensed Voice %s without exact arguments', async status => {
    connections = [{ id: 'draft', type: 'voice', status: 'pending', license_suspended: false }, voice(status)];
    await expect(placeTrackedVoiceCall(input)).resolves.toMatchObject({ call: { id: 'call-1' }, duplicate: false });
    expect(mockPlace).toHaveBeenCalledTimes(1);
    expect(mockPlace).toHaveBeenCalledWith(expect.objectContaining({ senderId: exact.selectedSenderId }));
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenCalledWith('get_site_licensed_resources', { p_site_id: input.siteId });
    expect(filters).toContainEqual(['messages', 'conversations.site_id', input.siteId]);
    expect(filters).toContainEqual(['leads', 'site_id', input.siteId]);
    expect(delivery).toMatchObject({ site_id: input.siteId, zavu_sender_id: exact.selectedSenderId });
  });

  it.each(VOICE_ACTIVE_STATUSES)('exact placement accepts licensed Voice %s without changing the pinned sender', async status => {
    connections = [{ ...voice('connected'), id: 'first', zavu_sender_id: 'other-sender' }, voice(status)];
    await expect(placeTrackedVoiceCall({ ...input, ...exact })).resolves.toMatchObject({ call: { id: 'call-1' } });
    expect(mockPlace).toHaveBeenCalledWith(expect.objectContaining({ senderId: exact.selectedSenderId }));
  });

  it('legacy placement skips a suspended first Voice sender and ignores unrelated inactive same-sender rows', async () => {
    connections = [
      { ...voice('connected'), id: 'first', zavu_sender_id: 'suspended-sender', license_suspended: true },
      voice('active'),
      { ...voice('pending'), id: 'inactive', enabled: false },
    ];
    await expect(placeTrackedVoiceCall(input)).resolves.toMatchObject({ call: { id: 'call-1' } });
    expect(mockPlace).toHaveBeenCalledTimes(1);
    expect(mockPlace).toHaveBeenCalledWith(expect.objectContaining({ senderId: exact.selectedSenderId }));
  });

  it.each(['active', 'synced'])('expired raw Voice %s is denied when the RPC projects suspension', async status => {
    const raw = voice(status);
    connections = [{ ...raw, status: 'license_suspended', license_suspended: true }];
    await expect(placeTrackedVoiceCall(input)).rejects.toMatchObject({ deliveryStatus: 'failed' });
    customData = { status: 'pending', command_status: 'pending' };
    await expect(placeTrackedVoiceCall({ ...input, ...exact })).rejects.toMatchObject({ deliveryStatus: 'failed' });
    expect(raw.status).toBe(status);
    expect(mockPlace).not.toHaveBeenCalled();
    expect(mockSetContactContext).not.toHaveBeenCalled();
    expect(delivery).toBeNull();
  });

  it.each(['active', 'synced'])('final placement recheck denies %s expiry during contact preparation', async status => {
    connections = [voice(status)];
    mockSetContactContext.mockImplementationOnce(async () => {
      connections = [{ ...voice(status), status: 'license_suspended', license_suspended: true }];
    });
    await expect(placeTrackedVoiceCall({ ...input, ...exact })).rejects.toMatchObject({ status: 403, deliveryStatus: 'failed' });
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockPlace).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({ status: 'failed' });
    expect(mockClearContactContext).toHaveBeenCalledWith(expect.objectContaining({ phone: input.to }));
  });

  it.each([
    { status: 'pending' }, { status: 'disconnected' }, { status: 'license_suspended' },
    { status: 'active', enabled: false }, { status: 'synced', license_suspended: true },
    { type: 'telegram', status: 'active' }, { zavu_sender_id: 'wrong-sender' },
  ])('rejects invalid exact Voice selection %j', async extra => {
    connections = [{ ...voice('connected'), ...extra }];
    await expect(placeTrackedVoiceCall({ ...input, ...exact })).rejects.toMatchObject({ deliveryStatus: 'failed' });
    expect(mockPlace).not.toHaveBeenCalled();
    expect(mockSetContactContext).not.toHaveBeenCalled();
  });

  it('rejects duplicate exact IDs even when the duplicate is inactive', async () => {
    connections = [voice('active'), { ...voice('pending'), enabled: false }];
    await expect(placeTrackedVoiceCall({ ...input, ...exact })).rejects.toMatchObject({ deliveryStatus: 'failed' });
    expect(mockPlace).not.toHaveBeenCalled();
  });

  it('legacy selection rejects duplicate connection IDs at final dispatch', async () => {
    connections = [voice('active'), { ...voice('pending'), enabled: false }];
    await expect(placeTrackedVoiceCall(input)).rejects.toMatchObject({ status: 403, deliveryStatus: 'failed' });
    expect(mockPlace).not.toHaveBeenCalled();
  });

  it('final dispatch does not silently follow a replacement sender on the selected connection', async () => {
    connections = [voice('synced')];
    mockSetContactContext.mockImplementationOnce(async () => {
      connections = [{ ...voice('synced'), zavu_sender_id: 'replacement-sender' }];
    });
    await expect(placeTrackedVoiceCall(input)).rejects.toMatchObject({ status: 403, deliveryStatus: 'failed' });
    expect(mockPlace).not.toHaveBeenCalled();
  });

  it('channel-specific aliases never authorize active or synced non-voice channels', async () => {
    for (const channel of ['telegram', 'messenger', 'email', 'whatsapp']) {
      for (const status of ['active', 'synced']) {
        expect(isChannelActiveStatus(channel, status)).toBe(false);
        connections = [{ ...voice(status), type: channel }];
        await expect(requireLicensedChannel(input.siteId, channel, 'chosen', 'chosen-sender')).rejects.toMatchObject({ status: 403 });
      }
    }
    expect(mockPlace).not.toHaveBeenCalled();
  });
});