const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockSupport = jest.fn();
const mockInternalRequest = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc } }));
jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: { from: mockFrom, schema: () => ({ from: mockFrom }) },
}));
jest.mock('@/lib/services/workflow-service', () => ({
  WorkflowService: { getInstance: () => ({ customerSupportMessage: mockSupport }) },
}));
jest.mock('@/lib/security/upstash-rest', () => ({
  sha256: jest.fn(async () => 'hash'), getCachedJson: jest.fn(), setCachedJson: jest.fn(),
}));
jest.mock('../client', () => ({}));
jest.mock('../voice-webhook-handler', () => ({}));
jest.mock('@/lib/services/site-configuration-cache', () => ({}));
jest.mock('@/lib/utils/token-encryption', () => ({}));
jest.mock('@/lib/security/request-rate-limit', () => ({ isInternalServiceRequest: mockInternalRequest }));

import { handleInboundMessage } from '../webhook-handlers';
import { checkZavuSupportAdmission } from '@/app/api/agents/customerSupport/message/zavu-admission';
import { inboundDatabase, SITE, OWNER } from './inbound-lead-test-database';

const event = { id: 'event-1', senderId: 'sender-1', data: {
  from: 'telegram:12345', channel: 'telegram', text: 'Please help', messageId: 'incoming-1',
} };
const connection = { id: 'connection-1', type: 'telegram', status: 'connected',
  enabled: true, license_suspended: false, zavu_sender_id: 'sender-1' };

describe('manual-disabled Zavu inbound automation and history', () => {
  let state: ReturnType<typeof inboundDatabase>;
  let projected: Record<string, any>;
  beforeEach(() => {
    jest.clearAllMocks();
    projected = { ...connection };
    mockInternalRequest.mockReturnValue(true);
    state = inboundDatabase(mockFrom, { settings: [{ site_id: SITE, channels: { connections: [connection] } }] });
    mockRpc.mockImplementation(() => ({ abortSignal: async () => ({ data: {
      effective_plan: 'engine', social_media: [], channels: { connections: [projected] },
    }, error: null }) }));
    mockSupport.mockResolvedValue({ success: true });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('pins the enabled webhook identity into the workflow request', async () => {
    await handleInboundMessage(event);
    expect(mockSupport).toHaveBeenCalledWith(expect.objectContaining({ site_id: SITE,
      custom_data: { source: 'zavu_inbound_message', connection_id: connection.id,
        zavu_sender_id: 'sender-1', zavu_from: event.data.from, channel: 'telegram' },
    }), expect.any(Object));
    expect(mockRpc).toHaveBeenCalledWith('get_site_licensed_resources', { p_site_id: SITE });
  });

  it.each([{ enabled: false }, { _license: { manually_disabled: true } }, { license_suspended: true }])(
    'retains only user history without support for projected denial %j', async extra => {
      projected = { ...connection, ...extra };
      await handleInboundMessage(event);
      await handleInboundMessage(event);
      expect(mockSupport).not.toHaveBeenCalled();
      expect(state.tables.conversations).toHaveLength(1);
      expect(state.tables.messages).toHaveLength(1);
      expect(state.tables.messages[0]).toMatchObject({ user_id: OWNER, role: 'user', content: event.data.text,
        custom_data: { origin_message_id: 'incoming-1', automation_suppressed: true, connection_id: connection.id },
      });
      expect(state.tables.conversations[0]).toMatchObject({ site_id: SITE, channel: 'telegram' });
      expect(state.tables.leads).toEqual([]);
    },
  );

  it('fails closed on unavailable projection, retains history, and remains retryable', async () => {
    mockRpc.mockImplementation(() => ({ abortSignal: async () => ({ data: null, error: { message: 'offline' } }) }));
    await expect(handleInboundMessage(event)).rejects.toMatchObject({ status: 503 });
    expect(mockSupport).not.toHaveBeenCalled();
    expect(state.tables.messages).toHaveLength(1);
  });

  it('rejects ambiguous site or connection mappings instead of guessing a tenant', async () => {
    state.tables.settings.push({ site_id: 'other-site', channels: { connections: [connection] } });
    await handleInboundMessage(event);
    expect(mockSupport).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    state.tables.settings.pop();
    state.tables.settings[0].channels.connections.push({ ...connection });
    await handleInboundMessage(event);
    expect(mockSupport).not.toHaveBeenCalled();
  });

  it('propagates persistence failures without allowing automation', async () => {
    projected.enabled = false;
    state.failNextTable = 'messages';
    await expect(handleInboundMessage(event)).rejects.toThrow('Unable to preserve incoming message history');
    expect(mockSupport).not.toHaveBeenCalled();
  });

  it('rechecks the same destination after a delayed Temporal request', async () => {
    await handleInboundMessage(event);
    const body = mockSupport.mock.calls[0][0];
    projected._license = { manually_disabled: true };
    const response = await checkZavuSupportAdmission(new Request('https://api.example.test'), body);
    expect(await response!.json()).toEqual({ success: true, skipped: 'channel_unavailable' });
    expect(state.tables.messages).toHaveLength(1);
  });

  it('does not authorize a browser-supplied channel ingestion marker', async () => {
    await handleInboundMessage(event);
    mockRpc.mockClear();
    mockInternalRequest.mockReturnValue(false);
    const response = await checkZavuSupportAdmission(new Request('https://api.example.test'), mockSupport.mock.calls[0][0]);
    expect(response!.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(state.tables.messages).toEqual([]);
  });

  it('denies malformed pinned identity without querying resources', async () => {
    const response = await checkZavuSupportAdmission(new Request('https://api.example.test'), {
      custom_data: { source: 'zavu_inbound_message', connection_id: null },
    });
    expect(response!.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('does not invent an idempotency identity for denied history without a provider message ID', async () => {
    projected.enabled = false;
    await handleInboundMessage({ ...event, id: undefined, data: { ...event.data, messageId: undefined } });
    expect(mockSupport).not.toHaveBeenCalled();
    expect(state.tables.messages).toEqual([]);
  });
});