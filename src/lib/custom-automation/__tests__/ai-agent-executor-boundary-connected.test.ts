import { randomBytes, randomUUID } from 'node:crypto';
import { AIAgentExecutor } from '../ai-agent-executor';
import { createRequirementExecutionBoundary } from '@/app/api/robots/instance/assistant/requirement-execution-boundary';
import { MemorySessionStore } from '@/lib/harness/memory-store';
import { createMemoryArtifactStore } from '@/lib/harness/artifact-store';
import { createRedactor } from '@/lib/harness/security';
import type { HarnessSession } from '@/lib/harness/types';
import { createAssistantOnStepHandler } from '@/lib/services/robot-instance/assistant-logging';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
const originalEnv = process.env;
beforeEach(() => {
  process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
  for (const method of ['log', 'warn', 'error'] as const) jest.spyOn(console, method).mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

it.each(['deadline', 'execution-check', 'lease', 'save'])('preserves %s through the real executor and durability adapter before provider dispatch', async failure => {
  const id = randomUUID(), requirementId = randomUUID(), owner = randomUUID();
  const run = { requirementId, sessionId: id, siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), runId: randomUUID(), executionGeneration: 1 };
  const store = new MemorySessionStore();
  const session: HarnessSession = { id, version: 0, status: 'queued',
    request: { objective: 'Offline failure', repository: { url: 'https://example.test/repo' }, requirementId,
      limits: { maxTurns: 10, maxOutputTokens: 2000, maxTotalTokens: 2000000, maxActiveMs: 600000 } },
    turns: 0, allocatedTokens: 0, activeMs: 0, messages: [], uncertainOperations: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await store.create(session, run);
  const claimed = (await store.claim(id, run.siteId, owner, 60))!;
  const controller = new AbortController();
  const assertActive = jest.fn(async () => {});
  const adapter = createRequirementExecutionBoundary({ session: claimed, run, store, owner,
    artifacts: createMemoryArtifactStore(store), tools: [], redact: createRedactor(),
    assertActive, signal: controller.signal, writeLog: async () => {} });
  await adapter.initialize();
  const timeout = new DOMException('Offline host deadline', 'TimeoutError');
  adapter.boundary.billing = { beforeDispatch: jest.fn(async () => {}), settle: jest.fn(async () => {}), failed: jest.fn(async () => {}) };
  if (failure === 'deadline') assertActive.mockImplementationOnce(async () => { controller.abort(timeout); throw timeout; });
  if (failure === 'execution-check') assertActive.mockRejectedValueOnce(new Error('Private ownership details'));
  if (failure === 'lease') jest.spyOn(store, 'assertOwner').mockRejectedValueOnce(new Error('Private lease details'));
  if (failure === 'save') jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('Private snapshot details'));
  const executor = new AIAgentExecutor({ siteId: run.siteId });
  const create = jest.fn(); (executor as any).client.chat.completions.create = create;
  const error = await executor.act({ prompt: 'Run', tools: [], executionBoundary: adapter.boundary, maxIterations: 1 }).catch(error => error);
  if (failure === 'deadline') expect(error).toBe(timeout);
  else expect(error).toMatchObject({ name: 'RecoveryError', code: {
    'execution-check': 'execution_check_failed', lease: 'session_lease_failed', save: 'session_save_failed',
  }[failure], message: 'Assistant execution boundary failed' });
  expect(create).not.toHaveBeenCalled();
  expect(adapter.boundary.billing.beforeDispatch).not.toHaveBeenCalled();
  expect(adapter.boundary.billing.failed).not.toHaveBeenCalled();
  expect((await store.load(id, run.siteId))?.pending).toBeUndefined();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('preserves canonical interrupted-tool continuation through the real executor without another provider dispatch', async () => {
  const id = randomUUID(), requirementId = randomUUID(), owner = randomUUID();
  const run = { requirementId, sessionId: id, siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), runId: randomUUID(), executionGeneration: 1 };
  const session: HarnessSession = { id, version: 0, status: 'queued',
    request: { objective: 'Offline interruption', repository: { url: 'https://example.test/repository' }, requirementId,
      limits: { maxTurns: 10, maxOutputTokens: 2000, maxTotalTokens: 2000000, maxActiveMs: 600000 } },
    turns: 0, allocatedTokens: 0, activeMs: 0, messages: [], uncertainOperations: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const store = new MemorySessionStore(); await store.create(session, run);
  const claimed = (await store.claim(id, run.siteId, owner, 60))!;
  const controller = new AbortController();
  const execute = jest.fn(async (_args, context) => {
    controller.abort(new DOMException('Offline tool deadline', 'TimeoutError'));
    // Exercises nested guard propagation, not only a raw throw from the tool.
    await context.assertActive();
    return { ok: true };
  });
  const tool = { name: 'write', effect: 'write' as const, description: 'Offline write', parameters: { type: 'object', properties: {} }, execute };
  const adapter = createRequirementExecutionBoundary({ session: claimed, run, store, owner,
    artifacts: createMemoryArtifactStore(store), tools: [tool], redact: createRedactor(),
    assertActive: async () => {}, signal: controller.signal, writeLog: async () => {} });
  adapter.boundary.billing = { beforeDispatch: jest.fn(async () => {}), settle: jest.fn(async () => {}), failed: jest.fn(async () => {}) };
  await adapter.initialize();
  const executor = new AIAgentExecutor({ siteId: run.siteId });
  const create = jest.fn().mockResolvedValue({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
    { id: 'original', type: 'function', function: { name: 'write', arguments: '{}' } },
  ] }, finish_reason: 'tool_calls' }] });
  (executor as any).client.chat.completions.create = create;
  await expect(executor.act({ tools: [{ ...tool, execute: args => adapter.executeHarnessTool('write', args) }],
    messages: adapter.getMessages(), executionBoundary: adapter.boundary, maxOutputTokens: 1000, maxIterations: 1 }))
    .rejects.toMatchObject({ code: 'canonical_slice_interrupted' });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
  expect(await store.load(id, run.siteId)).toMatchObject({ pending: { call: { id: 'original' }, effect: 'write' } });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each([false, true])('connects durable receipts and finishes on a fresh adapter after secondary audit failure=%s', async auditFailure => {
  const id = randomUUID();
  const requirementId = randomUUID();
  const owner = randomUUID();
  const run = { requirementId, sessionId: id, siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(),
    runId: randomUUID(), executionGeneration: 1 };
  const session: HarnessSession = { id, version: 0, status: 'queued',
    request: { objective: 'Offline connected test', repository: { url: 'https://example.test/repository' }, requirementId,
      limits: { maxTurns: 10, maxOutputTokens: 2000, maxTotalTokens: 2000000, maxActiveMs: 600000 } },
    turns: 0, allocatedTokens: 0, activeMs: 0, messages: [], uncertainOperations: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const store = new MemorySessionStore();
  await store.create(session, { siteId: run.siteId, userId: run.userId });
  const claimed = await store.claim(id, run.siteId, owner, 60);
  expect(claimed).not.toBeNull();
  const logs: any[] = [];
  const adapter = createRequirementExecutionBoundary({ session: claimed!, run, store, owner,
    artifacts: createMemoryArtifactStore(store), tools: [], redact: createRedactor(),
    assertActive: async () => {}, signal: new AbortController().signal,
    writeLog: async event => { logs.push(structuredClone(event)); } });
  adapter.boundary.billing = { beforeDispatch: jest.fn(async () => {}), settle: jest.fn(async () => {}), failed: jest.fn(async () => {}) };
  await adapter.initialize();
  const executor = new AIAgentExecutor({ siteId: run.siteId });
  const response = (tool_calls: any[]) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls }, finish_reason: 'tool_calls' }] });
  const call = (id: string, name: string, args: any) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const create = jest.fn().mockResolvedValueOnce(response([
    call('history', 'read_session_history', { offset: '0', limit: '1' }),
    call('unknown', 'unavailable_tool', {}),
  ])).mockResolvedValueOnce(response([
    call('finish', 'finish_task', { summary: 'Offline checks completed', outcome: 'partial' }),
  ]));
  (executor as any).client.chat.completions.create = create;
  const onStep = jest.fn(async (_step: any, _meta?: { streamingLogId?: string }) => {});
  if (auditFailure) {
    jest.mocked(supabaseAdmin.from).mockReturnValue({ insert: () => ({ select: () => ({ single: async () => ({
      data: null, error: { message: 'Offline timeline unavailable' },
    }) }) }) } as any);
    const logStep = createAssistantOnStepHandler(run.instanceId, run.siteId, run.userId, 'openrouter',
      undefined, undefined, requirementId, undefined, { strict: true, redact: createRedactor() });
    onStep.mockImplementationOnce(logStep);
  }
  const first = await executor.act({ tools: adapter.controlTools, messages: adapter.getMessages(),
    executionBoundary: adapter.boundary, maxOutputTokens: 1000, maxIterations: 1, onStep }).catch(error => {
      if (!auditFailure) throw error;
      expect(error).toMatchObject({ code: 'canonical_audit_unavailable' });
      return undefined;
    });
  const stored = await store.load(id, run.siteId);
  const approved = stored!.messages.find(message => message.toolCalls)?.toolCalls!;
  expect(JSON.parse(approved[0].arguments)).toEqual({ offset: 0, limit: 1 });
  if (!auditFailure) expect(first!.steps[0].toolCalls?.[0].args).toEqual({ offset: 0, limit: 1 });
  const receipts = stored!.messages.filter(message => message.role === 'tool');
  expect(receipts.map(message => message.toolCallId)).toEqual(['history', 'unknown']);
  expect(JSON.parse(receipts[0].content)).toMatchObject({ ok: true });
  expect(JSON.parse(receipts[1].content)).toMatchObject({ ok: false, output: { success: false, executed: false, error: 'tool_not_found' } });
  expect(stored!.pending).toBeUndefined();
  expect(logs.filter(event => event.log_type === 'tool_result').map(event => event.tool_call_id)).toEqual(['history', 'unknown']);
  const next = createRequirementExecutionBoundary({ session: stored!, run, store, owner,
    artifacts: createMemoryArtifactStore(store), tools: [], redact: createRedactor(),
    assertActive: async () => {}, signal: new AbortController().signal, writeLog: async () => {} });
  next.boundary.billing = adapter.boundary.billing;
  await next.initialize();
  await executor.act({ tools: next.controlTools, messages: next.getMessages(), executionBoundary: next.boundary,
    maxOutputTokens: 1000, maxIterations: 1, onStep });
  await next.finish();
  const finished = await store.load(id, run.siteId);
  expect(finished).toMatchObject({ status: 'completed', reason: 'partial' });
  expect(finished!.pending).toBeUndefined();
  expect(finished!.messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['history', 'unknown', 'finish']);
  expect(onStep).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledTimes(2);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});