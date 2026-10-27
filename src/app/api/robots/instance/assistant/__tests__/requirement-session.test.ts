import { randomUUID } from 'node:crypto';
import { createMemorySessionStore } from '@/lib/harness/memory-store';
import { createMemoryArtifactStore } from '@/lib/harness/artifact-store';
import { createSession, sessionRequestSchema } from '@/lib/harness/session';
import { createRedactor } from '@/lib/harness/security';
import { readRequirementAssistantHost } from '../requirement-host';
import { OpenRouterBillingError, RequirementCreditsExhaustedError } from '@/lib/services/billing/openrouter-usage-billing';

const prepare = jest.fn();
const processTurn = jest.fn();
const writeLog = jest.fn(async (..._args: any[]) => {});
jest.mock('../assistant-context', () => ({ prepareAssistantContext: (...args: any[]) => prepare(...args) }));
jest.mock('../assistant-turn-core', () => ({ processAssistantTurn: (...args: any[]) => processTurn(...args) }));
jest.mock('../requirement-instance-log', () => ({ writeRequirementInstanceLog: (...args: any[]) => writeLog(...args) }));
jest.mock('../requirement-billing', () => ({ createRequirementAssistantBilling: () => ({}) }));
import { runRequirementAssistantSlice } from '../requirement-session';

async function fixture() {
  const store = createMemorySessionStore();
  const run = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(),
    sessionId: randomUUID(), runId: randomUUID(), executionGeneration: 2 };
  const initial = createSession(sessionRequestSchema.parse({ objective: 'Research without publishing.',
    repository: { url: 'https://example.test/repo.git' },
    limits: { maxTurns: 20, maxOutputTokens: 4096, maxTotalTokens: 1000000, maxActiveMs: 600000 } }), run.sessionId);
  initial.request.requirementId = run.requirementId;
  await store.create(initial, run);
  const owner = randomUUID();
  const session = (await store.claim(initial.id, run.siteId, owner, 300))!;
  const context = { executionOptions: { instance_id: run.instanceId, site_id: run.siteId, user_id: run.userId },
    systemPrompt: 'Canonical assistant policy', initialMessage: initial.request.objective };
  prepare.mockResolvedValue(context);
  const assertExecution = jest.fn(async () => {
    if ((await store.load(run.sessionId, run.siteId))?.status !== 'running') throw new Error('Owner inactive');
  });
  return { store, run, session, owner, assistantContext: context, assertExecution,
    artifacts: createMemoryArtifactStore(store), tools: [], redact: createRedactor(),
    signal: new AbortController().signal, workspace: { ref: { provider: 'vercel' as const, id: 'offline', root: '/workspace' } } as any };
}

beforeEach(() => { jest.clearAllMocks(); });

test('cron uses canonical context and turns, durable logs and the same session; finish is not prose', async () => {
  const input = await fixture();
  const getContext = jest.fn(async () => 'Current authorized requirement snapshot');
  const checkpointStatuses: Array<string | undefined> = [];
  const onCheckpoint = jest.fn(async (context: any) => {
    await context.assertActive();
    checkpointStatuses.push((await input.store.load(input.run.sessionId, input.run.siteId))?.status);
  });
  processTurn.mockImplementation(async (context, messages) => {
    expect(context).toBe(input.assistantContext);
    const host = readRequirementAssistantHost(context)!;
    expect(host).toBeDefined();
    expect(host).not.toHaveProperty('maxOutputTokens');
    expect(await host.refreshContext()).toContain('Current authorized requirement snapshot');
    await host.boundary.beforeModel({ system: context.systemPrompt, messages, tools: host.tools, maxOutputTokens: 4096 });
    const args = { summary: 'No external publication performed.', outcome: 'partial' };
    await host.boundary.onModelMessage({ role: 'assistant', content: '', tool_calls: [
      { id: 'finish-once', type: 'function', function: { name: 'finish_task', arguments: JSON.stringify(args) } },
    ] });
    await host.boundary.executeTool({ id: 'finish-once', name: 'finish_task', args },
      () => host.tools.find(tool => tool.name === 'finish_task').execute(args));
    await host.boundary.afterTurn([]);
    return { messages, isDone: true };
  });
  const result = await runRequirementAssistantSlice({ ...input, getContext, onCheckpoint });
  expect(result.status).toBe('completed');
  expect(result.id).toBe(input.run.sessionId);
  expect(result.turns).toBe(1);
  expect(prepare).toHaveBeenCalledWith(input.run.instanceId, input.session.request.objective,
    input.run.siteId, input.run.userId, [], false, undefined, undefined, undefined, undefined,
    1, undefined, undefined, undefined, undefined,
    expect.objectContaining({ requirementId: input.run.requirementId, assertActive: input.assertExecution }));
  expect(writeLog).toHaveBeenCalled();
  expect(processTurn).toHaveBeenCalledTimes(1);
  expect(onCheckpoint).toHaveBeenCalledTimes(1);
  expect(checkpointStatuses).toEqual(['running']);
});

test('a slice break with a long legacy transcript reaches the source checkpoint without copying history to logs', async () => {
  const input = await fixture();
  input.session.messages = Array.from({ length: 242 }, (_, index) => ({
    role: 'assistant' as const, content: `Historical observation ${index}`,
  }));
  input.session = await input.store.save(input.session, input.run.siteId, input.owner);
  const onCheckpoint = jest.fn(async (context: any) => { await context.assertActive(); });
  const result = await runRequirementAssistantSlice({ ...input, sliceMs: 0, onCheckpoint });
  expect(result.status).toBe('running');
  expect(result.messages).toEqual(input.session.messages);
  const saved = await input.store.load(input.run.sessionId, input.run.siteId);
  expect(saved).toMatchObject({ messages: input.session.messages, assistantAuditCursor: 242,
    turns: input.session.turns, allocatedTokens: input.session.allocatedTokens });
  expect(saved!.activeMs).toBeGreaterThanOrEqual(input.session.activeMs);
  expect(processTurn).not.toHaveBeenCalled();
  expect(writeLog).not.toHaveBeenCalled();
  expect(onCheckpoint).toHaveBeenCalledTimes(1);
  expect(onCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ owner: input.owner, signal: input.signal }));
});

test('legacy pending effects stop before context/model/tools, without erasing counters or receipts', async () => {
  const input = await fixture();
  input.session.turns = 5;
  input.session.messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'old-send', name: 'publish', arguments: '{}' }] });
  input.session = await input.store.save(input.session, input.run.siteId, input.owner);
  await expect(runRequirementAssistantSlice(input)).resolves.toMatchObject({
    status: 'paused', reason: 'migration_pending_operation_requires_reconciliation',
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(processTurn).not.toHaveBeenCalled();
  const saved = await input.store.load(input.run.sessionId, input.run.siteId);
  expect(saved?.status).toBe('paused');
  expect(saved?.turns).toBe(5);
  expect(saved?.messages.some(message => message.toolCalls?.[0]?.id === 'old-send')).toBe(true);
});

test.each([new RequirementCreditsExhaustedError(0.4), new OpenRouterBillingError()])('preserves terminal billing instance through the session: %s', async error => {
  const input = await fixture();
  processTurn.mockRejectedValueOnce(error);
  await expect(runRequirementAssistantSlice(input)).rejects.toBe(error);
  expect(processTurn).toHaveBeenCalledTimes(1);
});

test('bare creditExhausted result cannot establish reservation provenance', async () => {
  const input = await fixture();
  processTurn.mockResolvedValueOnce({ creditExhausted: true });
  const error = await runRequirementAssistantSlice(input).catch(error => error);
  expect(error.name).toBe('OpenRouterBillingError');
  expect(error).not.toBeInstanceOf(RequirementCreditsExhaustedError);
  expect(processTurn).toHaveBeenCalledTimes(1);
});