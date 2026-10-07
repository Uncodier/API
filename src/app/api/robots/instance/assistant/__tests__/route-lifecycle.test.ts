import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CreditService } from '@/lib/services/billing/CreditService';
import { start } from 'workflow/api';
import { resetRequirementOnUserAction } from '@/lib/services/requirement-cron-reset';
import { runAssistantWorkflow } from '../workflow';
import { insertUserActionLog, markRemoteInstanceError } from '../user-message-log';
import { POST } from '../route';
import { normalizePublishToolOverrides } from '../publish-tool-overrides';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: { validateCredits: jest.fn() } }));
jest.mock('workflow/api', () => ({ start: jest.fn() }));
jest.mock('../workflow', () => ({ runAssistantWorkflow: jest.fn() }));
jest.mock('@/lib/services/requirement-cron-reset', () => ({ resetRequirementOnUserAction: jest.fn() }));
jest.mock('../user-message-log', () => ({
  insertUserActionLog: jest.fn(), markRemoteInstanceError: jest.fn(), withRetries: (fn: () => unknown) => fn(),
}));
jest.mock('../publish-tool-overrides', () => ({ normalizePublishToolOverrides: jest.fn(() => ({})) }));
jest.mock('../skill-selection', () => {
  const { z } = jest.requireActual('zod');
  return { assistantSkillSelectionSchema: z.object({}), approvedCommunityImport: () => null,
    resolveAssistantSkillSelection: async () => ({ skill_mode: 'auto', skills: [] }) };
});
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('@/lib/services/site-skill-access', () => ({ isSiteSkillManager: jest.fn() }));

const INSTANCE = '00000000-0000-4000-8000-000000000001';
const SITE = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000003';
const LOG = '00000000-0000-4000-8000-000000000004';
const request = (body: unknown) => new NextRequest('https://example.com/api/robots/instance/assistant', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const payload = { instance_id: INSTANCE, site_id: SITE, user_id: USER, message: 'Repeated question', request_id: 'request-2' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (CreditService.validateCredits as jest.Mock).mockResolvedValue(true);
  (insertUserActionLog as jest.Mock).mockResolvedValue({ id: LOG });
  (markRemoteInstanceError as jest.Mock).mockResolvedValue(undefined);
  (resetRequirementOnUserAction as jest.Mock).mockResolvedValue(undefined);
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const query: any = {};
    for (const name of ['select', 'eq', 'insert']) query[name] = jest.fn(() => query);
    const data = table === 'sites' ? { user_id: USER }
      : { id: INSTANCE, site_id: SITE, user_id: USER, status: 'error' };
    query.maybeSingle = query.single = jest.fn(async () => ({ data, error: null }));
    return query;
  });
  (start as jest.Mock).mockResolvedValue({ runId: 'run', status: Promise.resolve('completed'),
    returnValue: Promise.resolve({ assistant_response: 'Answer' }) });
});
afterEach(() => jest.restoreAllMocks());

it('persists a fresh turn before workflow start and sends its ID through the SSE acknowledgement', async () => {
  const response = await POST(request(payload));
  const body = await response.text();
  expect(insertUserActionLog).toHaveBeenCalledWith(expect.objectContaining({
    instanceId: INSTANCE, siteId: SITE, skipDuplicateCheck: true,
    details: expect.objectContaining({ request_id: 'request-2', status: 'running' }),
  }));
  expect((insertUserActionLog as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((start as jest.Mock).mock.invocationCallOrder[0]);
  expect((start as jest.Mock).mock.calls[0][1][13]).toMatchObject({ userMessageLogId: LOG });
  expect(body).toContain(`"user_log_id":"${LOG}"`);
  expect(body).toContain('event: completed');
});

it('uses the same lifecycle for a newly created session', async () => {
  const response = await POST(request({ site_id: SITE, message: 'New question' }));
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain('event: accepted');
  expect(body).toContain('event: completed');
  expect((start as jest.Mock).mock.calls[0][1][13]).toMatchObject({ userMessageLogId: LOG });
});

it('persists the initiating node identity with the trusted user action', async () => {
  const nodeId = '00000000-0000-4000-8000-000000000005';
  const response = await POST(request({ ...payload, instance_node_id: nodeId }));
  await response.text();
  expect(insertUserActionLog).toHaveBeenCalledWith(expect.objectContaining({
    details: expect.objectContaining({ instance_node_id: nodeId, status: 'running' }),
  }));
  expect((start as jest.Mock).mock.calls[0][1][9]).toBe(nodeId);
});

it('waits for trusted user-action recovery before starting an interactive retry, not a cron workflow', async () => {
  let finishRecovery!: () => void;
  let recoveryStarted!: () => void;
  const started = new Promise<void>(resolve => { recoveryStarted = resolve; });
  (resetRequirementOnUserAction as jest.Mock).mockImplementation(() => {
    recoveryStarted();
    return new Promise<void>(resolve => { finishRecovery = resolve; });
  });
  const pendingResponse = POST(request({ ...payload, message: 'reintenta' }));
  await started;
  expect(resetRequirementOnUserAction).toHaveBeenCalledWith(INSTANCE, LOG);
  expect(start).not.toHaveBeenCalled();
  finishRecovery();
  const response = await pendingResponse;
  expect(start).toHaveBeenCalledTimes(1);
  expect((start as jest.Mock).mock.calls[0][0]).toBe(runAssistantWorkflow);
  expect((start as jest.Mock).mock.calls[0][1][1]).toBe('reintenta');
  expect((start as jest.Mock).mock.calls[0][1][13]).toMatchObject({ userMessageLogId: LOG });
  expect(await response.text()).toContain('event: completed');
});

it('delivers workflow failure to the client independently of durable log visibility', async () => {
  (start as jest.Mock).mockResolvedValue({ runId: 'run', status: Promise.resolve('failed') });
  const response = await POST(request(payload));
  expect(await response.text()).toContain('ASSISTANT_WORKFLOW_FAILED');
});

it('returns a startup error even when recording that error also fails', async () => {
  (start as jest.Mock).mockRejectedValue(new Error('PRIVATE_PROVIDER_PAYLOAD'));
  (markRemoteInstanceError as jest.Mock).mockRejectedValue(new Error('Database unavailable'));
  const response = await POST(request(payload));
  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body.error.code).toBe('ASSISTANT_START_FAILED');
  expect(JSON.stringify(body)).not.toContain('PRIVATE_PROVIDER_PAYLOAD');
  expect(markRemoteInstanceError).toHaveBeenCalledWith(expect.objectContaining({ instanceId: INSTANCE, siteId: SITE }));
});

it('does not acknowledge or start work when the user message could not be persisted', async () => {
  (insertUserActionLog as jest.Mock).mockRejectedValue(new Error('Database unavailable'));
  const response = await POST(request(payload));
  expect(response.status).toBe(500);
  expect(start).not.toHaveBeenCalled();
  expect(markRemoteInstanceError).toHaveBeenCalled();
});

it('returns conflict without marking the original runner as failed when cron owns execution', async () => {
  (insertUserActionLog as jest.Mock).mockRejectedValue(new Error('Failed to persist user message: requirement_execution_busy'));
  const response = await POST(request(payload));
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe('REQUIREMENT_EXECUTION_BUSY');
  expect(start).not.toHaveBeenCalled();
  expect(resetRequirementOnUserAction).not.toHaveBeenCalled();
  expect(markRemoteInstanceError).not.toHaveBeenCalled();
});

it('does not write a session log for invalid input or insufficient credits', async () => {
  const invalid = await POST(request({}));
  expect(invalid.status).toBe(400);
  (CreditService.validateCredits as jest.Mock).mockResolvedValue(false);
  const denied = await POST(request(payload));
  expect(denied.status).toBe(402);
  expect(insertUserActionLog).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(markRemoteInstanceError).not.toHaveBeenCalled();
});

it.each([
  { nodeType: 'publish', publish_destinations: ['tiktok'] },
  { publish_destinations: [] },
  { nodeType: 'audience', mediaType: 'audience', audience_channels: ['email'] },
  { nodeType: 'text', output_type: 'text' },
  { nodeType: 'video', media_type: 'video', parameters: { duration: 8 } },
  { ui_contract: { version: 1, output_type: 'image' } },
  { instance_node_id: 'embedded-node', nodeType: 'generate-image' },
])('rejects unscoped node context before credits, admission or overrides: %j', async context => {
  for (const instance_id of [INSTANCE, undefined]) {
    const response = await POST(request({ ...payload, instance_id, context: JSON.stringify(context) }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({
      code: 'NODE_CONTEXT_REQUIRES_NODE',
      message: expect.stringContaining('instance_node_id'),
    });
  }
  expect(CreditService.validateCredits).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(normalizePublishToolOverrides).not.toHaveBeenCalled();
  expect(insertUserActionLog).not.toHaveBeenCalled();
  expect(resetRequirementOnUserAction).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(markRemoteInstanceError).not.toHaveBeenCalled();
});

it.each([
  'A conversation about a publish node, not a node execution.',
  'null',
  '[]',
  '{"nodeType":',
  JSON.stringify({ output_type: 'json', parameters: { tone: 'friendly' } }),
  JSON.stringify({ records: [{ nodeType: 'publish', output_type: 'image' }], assets: ['image-1'] }),
])('preserves ordinary conversational context without node identity: %s', async context => {
  const tool_overrides = { search: { limit: 3 } };
  const response = await POST(request({ ...payload, context, tool_overrides }));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('event: completed');
  expect((start as jest.Mock).mock.calls[0][1][9]).toBeUndefined();
  expect((start as jest.Mock).mock.calls[0][1][11]).toBe(context);
  expect((start as jest.Mock).mock.calls[0][1][12]).toEqual(tool_overrides);
  expect(normalizePublishToolOverrides).not.toHaveBeenCalled();
});

it('passes a node-specific request to durable scoped resolution without adopting embedded identity', async () => {
  const nodeId = '00000000-0000-4000-8000-000000000005';
  const context = JSON.stringify({ nodeType: 'publish', instance_node_id: 'untrusted-other-node' });
  const response = await POST(request({ ...payload, instance_node_id: nodeId, context }));
  expect(await response.text()).toContain('event: completed');
  expect(normalizePublishToolOverrides).toHaveBeenCalledWith(context, undefined);
  expect((start as jest.Mock).mock.calls[0][1][9]).toBe(nodeId);
});

it.each(['text', 'image', 'video', 'audio', 'audience'])('admits new and existing instance conversations with %s output preferences', async mediaType => {
  const context = JSON.stringify({
    mediaType, output_type: mediaType, parameters: { tone: 'friendly' },
    selected_context: { records: ['selected-record'] }, records: [{ id: 'selected-record' }],
  });
  const tool_overrides = { search: { limit: 3 } };
  for (const instance_id of [INSTANCE, undefined]) {
    jest.clearAllMocks();
    const response = await POST(request({ ...payload, instance_id, context, tool_overrides, expected_results_amount: 3 }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: completed');
    const args = (start as jest.Mock).mock.calls[0][1];
    expect(args[0]).toBe(INSTANCE);
    expect(args[9]).toBeUndefined();
    expect(args[10]).toBe(3);
    expect(args[11]).toBe(context);
    expect(args[12]).toEqual(tool_overrides);
    expect(insertUserActionLog).toHaveBeenCalledTimes(1);
    expect(normalizePublishToolOverrides).not.toHaveBeenCalled();
    expect(markRemoteInstanceError).not.toHaveBeenCalled();
  }
});

it('preserves legacy scoped-node overrides even when context only contains output preferences', async () => {
  const nodeId = '00000000-0000-4000-8000-000000000005';
  const context = JSON.stringify({ mediaType: 'publish', output_type: 'publish' });
  const tool_overrides = { sendBulkMessages: { channel: 'email', is_test: true } };
  const normalized = { publish: { channel: 'email', is_test: true } };
  (normalizePublishToolOverrides as jest.Mock).mockReturnValueOnce(normalized);
  const response = await POST(request({ ...payload, instance_node_id: nodeId, context, tool_overrides }));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('event: completed');
  expect(normalizePublishToolOverrides).toHaveBeenCalledWith(context, tool_overrides);
  expect((start as jest.Mock).mock.calls[0][1][9]).toBe(nodeId);
  expect((start as jest.Mock).mock.calls[0][1][12]).toEqual(normalized);
});