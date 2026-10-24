import { randomBytes, randomUUID } from 'node:crypto';
import { AIAgentExecutor } from '../ai-agent-executor';
import { createRequirementExecutionBoundary } from '@/app/api/robots/instance/assistant/requirement-execution-boundary';
import { MemorySessionStore } from '@/lib/harness/memory-store';
import { createMemoryArtifactStore } from '@/lib/harness/artifact-store';
import { createRedactor } from '@/lib/harness/security';
import type { HarnessSession } from '@/lib/harness/types';

jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn().mockResolvedValue(undefined) }));
const originalEnv = process.env;
beforeEach(() => {
  process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
  for (const method of ['log', 'warn', 'error'] as const) jest.spyOn(console, method).mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

it('connects canonical normalized control calls and unknown receipts to real durable boundary and finishes', async () => {
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
  const onStep = jest.fn(async () => {});
  const first = await executor.act({ tools: adapter.controlTools, messages: adapter.getMessages(),
    executionBoundary: adapter.boundary, maxOutputTokens: 1000, maxIterations: 1, onStep });
  const stored = await store.load(id, run.siteId);
  const approved = stored!.messages.find(message => message.toolCalls)?.toolCalls!;
  expect(JSON.parse(approved[0].arguments)).toEqual({ offset: 0, limit: 1 });
  expect(first.steps[0].toolCalls?.[0].args).toEqual({ offset: 0, limit: 1 });
  const receipts = stored!.messages.filter(message => message.role === 'tool');
  expect(receipts.map(message => message.toolCallId)).toEqual(['history', 'unknown']);
  expect(JSON.parse(receipts[0].content)).toMatchObject({ ok: true });
  expect(JSON.parse(receipts[1].content)).toMatchObject({ ok: false, output: { success: false, executed: false, error: 'tool_not_found' } });
  expect(stored!.pending).toBeUndefined();
  expect(logs.filter(event => event.log_type === 'tool_result').map(event => event.tool_call_id)).toEqual(['history', 'unknown']);
  await executor.act({ tools: adapter.controlTools, messages: adapter.getMessages(), executionBoundary: adapter.boundary,
    maxOutputTokens: 1000, maxIterations: 1, onStep });
  await adapter.finish();
  const finished = await store.load(id, run.siteId);
  expect(finished).toMatchObject({ status: 'completed', reason: 'partial' });
  expect(finished!.pending).toBeUndefined();
  expect(finished!.messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['history', 'unknown', 'finish']);
  expect(onStep).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledTimes(2);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});