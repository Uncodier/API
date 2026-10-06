import { createAssistantOnStepHandler } from '../assistant-logging';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ASSISTANT_CONTEXT_VERSION, assistantRuntimeProvenance } from '../assistant-context-version';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));

const writes: Array<{ operation: string; payload: any }> = [];
beforeEach(() => {
  jest.clearAllMocks();
  writes.length = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.mocked(supabaseAdmin.from).mockImplementation(() => ({
    insert: (payload: any) => {
      writes.push({ operation: 'insert', payload });
      return { error: null, select: () => ({ single: async () => ({ data: { id: 'parent-log' }, error: null }) }) };
    },
    update: (payload: any) => {
      writes.push({ operation: 'update', payload });
      return { eq: async () => ({ error: null }) };
    },
  }) as any);
});
afterEach(() => jest.restoreAllMocks());

it.each([false, true])('persists cost, BYOK and generation metadata for step and tool logs (stream=%s)', async streaming => {
  const usage = { promptTokens: 0, completionTokens: 4, totalTokens: 4,
    cost: 0, cost_details: { upstream_inference_cost: 0.001 }, is_byok: false };
  const onStep = createAssistantOnStepHandler('instance', 'site', 'user', 'legacy-provider');
  await onStep({ text: 'Done', provider: 'openrouter', model: 'openai/example', generationId: 'gen-offline', usage,
    toolCalls: [{ id: 'tool-1', toolName: 'lookup', args: {} }], toolResults: [],
  }, streaming ? { streamingLogId: 'existing-log' } : undefined);
  expect(writes).toHaveLength(2);
  expect(writes[0].operation).toBe(streaming ? 'update' : 'insert');
  for (const { payload } of writes) {
    expect(payload.tokens_used).toEqual(usage);
    expect(payload.details).toMatchObject({ provider: 'openrouter', model: 'openai/example', generation_id: 'gen-offline' });
    expect(payload.details).toMatchObject({ context_version: ASSISTANT_CONTEXT_VERSION, execution_mode: 'conversation' });
  }
  expect(writes[1].payload.parent_log_id).toBe(streaming ? 'existing-log' : 'parent-log');
});

it('records only validated runtime identifiers and does not invent missing deployment evidence', () => {
  const commit = 'a'.repeat(40);
  expect(assistantRuntimeProvenance({ VERCEL_GIT_COMMIT_SHA: commit, VERCEL_DEPLOYMENT_ID: 'dpl_offline' }))
    .toEqual({ context_version: ASSISTANT_CONTEXT_VERSION, runtime_commit_sha: commit, runtime_deployment_id: 'dpl_offline' });
  expect(assistantRuntimeProvenance({ VERCEL_GIT_COMMIT_SHA: 'invalid\nvalue', VERCEL_DEPLOYMENT_ID: 'not-a-deployment' }))
    .toEqual({ context_version: ASSISTANT_CONTEXT_VERSION });
  expect(assistantRuntimeProvenance({})).toEqual({ context_version: ASSISTANT_CONTEXT_VERSION });
});

it.each([
  [{ prompt_tokens: 0, input_tokens: 8, completion_tokens: 3 }, { promptTokens: 0, completionTokens: 3, totalTokens: 3 }],
  [{ input_tokens: 2, output_tokens: 3 }, { promptTokens: 2, completionTokens: 3, totalTokens: 5 }],
  [{ promptTokens: 2 }, { promptTokens: 2 }],
])('keeps token fallbacks without fabricating unknown cost or total: %j', async (usage, expected) => {
  await createAssistantOnStepHandler('instance', 'site', 'user', 'openrouter')({ usage });
  const tokens = writes[0].payload.tokens_used;
  expect(tokens).toEqual({ ...usage, ...expected });
  expect(tokens).not.toHaveProperty('cost');
  expect(JSON.stringify(tokens)).not.toContain('null');
});

it.each([false, true])('marks node provenance on both assistant and tool logs (stream=%s)', async streaming => {
  const onStep = createAssistantOnStepHandler('instance', 'site', 'user', 'openrouter',
    undefined, undefined, undefined, 'prompt-node');
  await onStep({ text: 'QA Product selected', toolCalls: [{ id: 'lookup', toolName: 'catalog_commerce', args: {} }],
    toolResults: [], usage: {} }, streaming ? { streamingLogId: 'existing-log' } : undefined);
  expect(writes).toHaveLength(2);
  for (const { payload } of writes) {
    expect(payload.details).toMatchObject({ execution_mode: 'node', instance_node_id: 'prompt-node' });
  }
});