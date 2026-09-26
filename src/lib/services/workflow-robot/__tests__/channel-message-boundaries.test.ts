// @ts-nocheck -- ESM Jest mocks are dynamically imported under the ES5 TS target.
import { jest } from '@jest/globals';

const from = jest.fn();
const materializeRunFromGraph = jest.fn();
const siteId = '11111111-1111-4111-8111-111111111111';
const instanceId = '22222222-2222-4222-8222-222222222222';
const runPlanId = '33333333-3333-4333-8333-333333333333';
const triggerId = '44444444-4444-4444-8444-444444444444';
let rows: any;

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('../materialize', () => ({ materializeRunFromGraph }));
const { channelMessageIdempotencyKey, getCompletedChannelMessageGuidance, prepareChannelMessageRuns } =
  await import('../channel-message');

beforeEach(() => {
  jest.clearAllMocks();
  rows = {
    workflow_triggers: [{ id: triggerId, instance_id: instanceId, site_id: siteId, kind: 'channel_message',
      enabled: true, config: { channel: 'web', name: 'Helpful workflow', priority: 90 } }],
    remote_instances: { site_id: siteId },
    workflow_runs: { run_plan_id: runPlanId, site_id: siteId, instance_id: instanceId, trigger_id: triggerId,
      idempotency_key: channelMessageIdempotencyKey(siteId, 'message-1', instanceId),
      payload: { source: 'channel_message', message_id: 'message-1', channel: 'web',
        message: 'Hi', connection_id: null }, status: 'completed', dry_run: false },
    instance_plans: { id: runPlanId, site_id: siteId, instance_id: instanceId, status: 'completed',
      metadata: { workflow_run: true, pre_response_only: true, dry_run: false,
        trigger_payload: { source: 'channel_message', message_id: 'message-1', channel: 'web',
          message: 'Hi', connection_id: null } },
      steps: [{ status: 'completed', result: { summary: 'Recommend a human review', data: {} } }] },
    settings: { channels: { connections: [] } },
  };
  from.mockImplementation((table: string) => {
    const q: any = {};
    q.select = jest.fn(() => q);
    q.eq = jest.fn(() => q);
    q.maybeSingle = jest.fn(async () => ({ data: table === 'workflow_triggers'
      ? rows.workflow_triggers[0] : rows[table], error: null }));
    q.then = (resolve: (value: any) => any) => Promise.resolve({ data: rows[table], error: null }).then(resolve);
    return q;
  });
  materializeRunFromGraph.mockResolvedValue({ run_plan_id: runPlanId, steps: [] });
});

const guidance = () => getCompletedChannelMessageGuidance({
  siteId, messageId: 'message-1', channel: 'web', runPlanIds: [runPlanId],
});

it('serves completed results only when every tenant/message/channel/trigger binding agrees', async () => {
  expect(await guidance()).toContain('Helpful workflow (priority 90): Recommend a human review');
  expect((await guidance()).length).toBeLessThanOrEqual(4800);
  rows.workflow_triggers[0].enabled = false;
  expect(await guidance()).toBe('');
  rows.workflow_triggers[0].enabled = true;
  rows.workflow_triggers[0].config.channel = 'email';
  expect(await guidance()).toBe('');
  rows.workflow_triggers[0].config.channel = 'web';
  rows.instance_plans.metadata.trigger_payload.message_id = 'another-message';
  expect(await guidance()).toBe('');
  rows.instance_plans.metadata.trigger_payload.message_id = 'message-1';
  rows.remote_instances.site_id = 'another-site';
  expect(await guidance()).toBe('');
  rows.remote_instances.site_id = siteId;
  rows.workflow_runs.payload.connection_id = 'forged-connection';
  expect(await guidance()).toBe('');
  rows.workflow_runs.payload.connection_id = null;
  rows.workflow_runs.payload.conversation_id = 'forged-conversation';
  expect(await guidance()).toBe('');
  delete rows.workflow_runs.payload.conversation_id;
  rows.settings.channels.connections = [{ id: 'conn-1', type: 'email', status: 'active' }];
  rows.instance_plans.metadata.trigger_payload.connection_id = 'conn-1';
  rows.workflow_runs.payload.connection_id = 'conn-1';
  rows.instance_plans.metadata.trigger_payload.channel = 'email';
  rows.workflow_runs.payload.channel = 'email';
  rows.workflow_triggers[0].config.channel = 'email';
  expect(await getCompletedChannelMessageGuidance({ siteId, messageId: 'message-1', channel: 'email', runPlanIds: [runPlanId] }))
    .toContain('Helpful workflow');
  rows.settings.channels.connections.push({ id: 'conn-2', type: 'email', status: 'synced' });
  expect(await getCompletedChannelMessageGuidance({ siteId, messageId: 'message-1', channel: 'email', runPlanIds: [runPlanId] }))
    .toBe('');
  rows.instance_plans.status = 'in_progress';
  expect(await guidance()).toBe('');
});

it('does not materialize a duplicate for another message or an over-limit trigger set', async () => {
  rows.workflow_triggers = Array.from({ length: 11 }, (_, i) => ({
    id: `trigger-${i}`, instance_id: `instance-${i}`, site_id: siteId,
    config: { channel: 'web' }, kind: 'channel_message', enabled: true,
  }));
  await expect(prepareChannelMessageRuns({ siteId, messageId: 'message-1', channel: 'web', message: 'Hi' }))
    .rejects.toThrow('Too many matching channel message workflows');
  expect(materializeRunFromGraph).not.toHaveBeenCalled();

  rows.workflow_triggers = [{ id: triggerId, instance_id: instanceId, site_id: siteId,
    kind: 'channel_message', enabled: true, config: { channel: 'web' } }];
  rows.workflow_runs.payload.message_id = 'another-message';
  await expect(prepareChannelMessageRuns({ siteId, messageId: 'message-1', channel: 'web', message: 'Hi' }))
    .rejects.toThrow('Channel message idempotency conflict');
});