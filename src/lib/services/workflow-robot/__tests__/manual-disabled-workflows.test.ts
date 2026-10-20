const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockMaterialize = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc, from: mockFrom } }));
jest.mock('../materialize', () => ({ materializeRunFromGraph: mockMaterialize }));
import { prepareChannelMessageRuns, resolveMessageConnection, loadBoundChannelMessageRun,
  channelMessageIdempotencyKey } from '../channel-message';

const SITE = '11111111-1111-4111-8111-111111111111';
const INSTANCE = '22222222-2222-4222-8222-222222222222';
const PLAN = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const CONVERSATION = '55555555-5555-4555-8555-555555555555';
const connection = { id: 'connection-1', type: 'telegram', status: 'connected',
  enabled: true, license_suspended: false, zavu_sender_id: 'sender-1' };

describe('manual-disabled workflow connection boundaries', () => {
  let connections: Record<string, any>[];
  let rows: Record<string, any>;
  beforeEach(() => {
    jest.clearAllMocks();
    connections = [{ ...connection }];
    const payload = { source: 'channel_message', channel: 'telegram', connection_id: connection.id,
      message_id: 'message-1', message: 'Hello' };
    const trigger = { id: 'trigger-1', instance_id: INSTANCE, site_id: SITE,
      kind: 'channel_message', enabled: true, config: {} };
    rows = {
      workflow_triggers: [trigger], remote_instances: { id: INSTANCE, site_id: SITE },
      workflow_runs: { site_id: SITE, instance_id: INSTANCE, trigger_id: trigger.id,
        idempotency_key: channelMessageIdempotencyKey(SITE, 'message-1', INSTANCE), payload, status: 'completed' },
      instance_plans: { id: PLAN, site_id: SITE, instance_id: INSTANCE, status: 'completed',
        metadata: { workflow_run: true, pre_response_only: true, trigger_payload: { ...payload } } },
      messages: null, conversations: null,
    };
    mockRpc.mockImplementation(() => ({ abortSignal: async () => ({ data: {
      effective_plan: 'engine', social_media: [], channels: { connections },
    }, error: null }) }));
    mockFrom.mockImplementation((table: string) => {
      const result = () => ({ data: rows[table], error: null });
      const q: any = { select: () => q, eq: () => q, limit: () => q,
        maybeSingle: async () => ({ data: table === 'workflow_triggers' ? rows[table][0] : rows[table], error: null }),
        then: (resolve: any) => Promise.resolve(result()).then(resolve) };
      return q;
    });
    mockMaterialize.mockResolvedValue({ run_plan_id: PLAN });
  });
  const prepare = (channel = 'telegram', messageId = 'message-1') => prepareChannelMessageRuns({
    siteId: SITE, messageId, channel, message: 'Hello',
  });
  const bound = () => loadBoundChannelMessageRun({ siteId: SITE, messageId: 'message-1', runPlanId: PLAN });

  it.each([{ enabled: false }, { _license: { manually_disabled: true } }, { license_suspended: true }, { status: 'active' }])(
    'does not fall through to wildcard triggers for denied projection %j', async extra => {
      connections = [{ ...connection, ...extra }];
      expect(await prepare()).toEqual([]);
      expect(mockMaterialize).not.toHaveBeenCalled();
      expect(await bound()).toBeNull();
    },
  );
  it('keeps wildcard workflows for an enabled external connection', async () => {
    expect(await prepare()).toEqual([{ runPlanId: PLAN, status: 'completed' }]);
    expect(mockMaterialize).toHaveBeenCalledWith(expect.objectContaining({
      trigger_payload: expect.objectContaining({ connection_id: connection.id }),
    }));
  });
  it('does not borrow the only enabled sender when incoming identity could be the disabled sender', async () => {
    connections.push({ ...connection, id: 'disabled', enabled: false, zavu_sender_id: 'other' });
    expect(await resolveMessageConnection(SITE, 'telegram')).toBeUndefined();
    expect(await prepare()).toEqual([]);
    expect(mockMaterialize).not.toHaveBeenCalled();
  });
  it('refuses old null-connection external runs, including wildcard runs', async () => {
    rows.workflow_runs.payload.connection_id = null;
    rows.instance_plans.metadata.trigger_payload.connection_id = null;
    expect(await bound()).toBeNull();
  });
  it('keeps first-party web wildcard workflows without a channel license RPC', async () => {
    rows.workflow_runs.payload.channel = 'web';
    rows.workflow_runs.payload.connection_id = null;
    rows.instance_plans.metadata.trigger_payload = { ...rows.workflow_runs.payload };
    expect(await prepare('web')).toEqual([{ runPlanId: PLAN, status: 'completed' }]);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('denies persisted exact destinations rather than falling back to another enabled sender', async () => {
    connections[0]._license = { manually_disabled: true };
    connections.push({ ...connection, id: 'other', zavu_sender_id: 'other' });
    rows.messages = { conversation_id: CONVERSATION, role: 'user', custom_data: { connection_id: connection.id } };
    rows.conversations = { site_id: SITE, channel: 'telegram' };
    await expect(prepare('telegram', MESSAGE)).rejects.toThrow();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });
  it('fails closed on projection outages before materialization', async () => {
    mockRpc.mockImplementation(() => ({ abortSignal: async () => ({ data: null, error: {} }) }));
    await expect(prepare()).rejects.toMatchObject({ status: 503 });
    expect(mockMaterialize).not.toHaveBeenCalled();
  });
});