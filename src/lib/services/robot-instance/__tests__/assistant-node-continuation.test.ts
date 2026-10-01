import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AssistantExecutionOptions } from '../assistant-execution-options';

const act = jest.fn<(options: any) => Promise<any>>();
const fetchContexts = jest.fn<(...args: any[]) => Promise<any[]>>();
const updateResult = jest.fn<(id: string, result: any) => Promise<void>>();
const createResponse = jest.fn<() => Promise<string>>();
const createBatch = jest.fn<(...args: any[]) => Promise<string[]>>();
const hydrate = jest.fn<(messages: any[]) => Promise<any[]>>();
const validateCredits = jest.fn<(...args: any[]) => Promise<boolean>>();
const deductCredits = jest.fn<(...args: any[]) => Promise<void>>();
const streamChunk = jest.fn<(...args: any[]) => Promise<void>>();
const createCallbacks = jest.fn<(...args: any[]) => any>(() => ({ onNodeStreamStart: createResponse }));
const queries: { table: string; filters: Record<string, unknown>; payload?: any }[] = [];
let nodes: Record<string, any>;

const from = jest.fn((table: string) => {
  const filters: Record<string, unknown> = {};
  const recorded: typeof queries[number] = { table, filters };
  let excludedStatuses = false;
  queries.push(recorded);
  const query: any = {
    select: jest.fn(() => query),
    update: jest.fn((payload: any) => { recorded.payload = payload; return query; }),
    eq: jest.fn((key: string, value: unknown) => { filters[key] = value; return query; }),
    not: jest.fn((key: string, operator: string, value: string) => {
      expect([key, operator, value]).toEqual(['status', 'in', '(stopped,cancelled)']);
      excludedStatuses = true;
      return query;
    }),
    single: jest.fn(async () => {
      if (recorded.payload) {
        if (excludedStatuses && ['stopped', 'cancelled'].includes(nodes[String(filters.id)]?.status)) {
          return { data: null, error: null };
        }
        if (!Object.entries(filters).every(([key, value]) => nodes[String(filters.id)]?.[key] === value)) {
          return { data: null, error: null };
        }
        await updateResult(String(filters.id), recorded.payload.result);
      }
      return { data: nodes[String(filters.id)] || null, error: null };
    }),
  };
  return query;
});

jest.unstable_mockModule('@/lib/custom-automation/ai-agent-executor', () => ({
  AIAgentExecutor: class { act = act; },
}));
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/services/billing/CreditService', () => ({
  CreditService: {
    validateCredits, deductCredits,
    PRICING: { ASSISTANT_INPUT_TOKEN_MILLION: 1, ASSISTANT_OUTPUT_TOKEN_MILLION: 2 },
  },
  InsufficientCreditsError: class extends Error {},
}));
jest.unstable_mockModule('../assistant-logging', () => ({
  createAssistantOnStepHandler: () => jest.fn(),
  fetchNodeContexts: fetchContexts,
  batchCreateResponseNodes: createBatch,
}));
jest.unstable_mockModule('../assistant-streaming-logs', () => ({
  createNodeStreamingCallbacks: createCallbacks,
  createStreamingLogCallbacks: () => ({
    onStreamStart: async () => 'log-1', onStreamChunk: streamChunk,
  }),
  createThinkingStreamLogCallbacks: () => ({}),
}));
jest.unstable_mockModule('../vision-message-images', () => ({ hydrateMessageImages: hydrate }));
jest.unstable_mockModule('../InstanceContextManager', () => ({ InstanceContextManager: class {} }));
jest.unstable_mockModule('../instance-context-budget', () => ({ measureInstanceContext: jest.fn() }));

let executeAssistantStep: typeof import('../assistant-executor').executeAssistantStep;
let executeAssistant: typeof import('../assistant-executor').executeAssistant;
let prepareAssistantTools: typeof import('../assistant-executor').prepareAssistantTools;
beforeAll(async () => {
  ({ executeAssistantStep, executeAssistant, prepareAssistantTools } = await import('../assistant-executor'));
});

const options: AssistantExecutionOptions = {
  instance_id: 'instance-1', site_id: 'site-1', user_id: 'user-1',
  instance_node_id: 'prompt-1', tool_overrides: { tools: { allowPublish: false } },
};
const prompt = { role: 'user', content: 'Edit the referenced image' };
const toolCall = {
  role: 'assistant', content: 'Generating the image',
  tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'generate_image', arguments: '{}' } }],
};
const toolReply = { role: 'tool', tool_call_id: 'call-1', content: '{"success":true}' };
const imageOutput = {
  tool_name: 'generate_image', type: 'image',
  data: { url: 'https://assets.example.test/generated.png' },
};
const imageStep = { toolResults: [{
  toolName: 'generate_image', result: { success: true, images: [imageOutput.data.url] },
}] };

function execution(messages: any[], text = '', steps: any[] = []) {
  return { text, steps, messages, output: null, usage: {} };
}

beforeEach(() => {
  jest.clearAllMocks();
  queries.length = 0;
  nodes = {
    'prompt-1': { id: 'prompt-1', instance_id: 'instance-1', site_id: 'site-1', settings: { output_type: 'image' } },
    'response-1': {
      id: 'response-1', type: 'response', parent_node_id: 'prompt-1',
      instance_id: 'instance-1', site_id: 'site-1', result: { text: '', status: 'running' },
    },
  };
  nodes['response-2'] = { ...nodes['response-1'], id: 'response-2' };
  validateCredits.mockResolvedValue(true);
  deductCredits.mockResolvedValue();
  hydrate.mockImplementation(async messages => messages);
  fetchContexts.mockResolvedValue([]);
  createResponse.mockResolvedValue('response-1');
  createBatch.mockResolvedValue(['response-1', 'response-2']);
  updateResult.mockImplementation(async (id, result) => {
    if (nodes[id]) nodes[id].result = result;
  });
  streamChunk.mockResolvedValue();
  act.mockResolvedValue(execution([{ role: 'assistant', content: 'Finished' }], 'Finished'));
});

describe('node executor chunk continuation', () => {
  it('assembles initial references once, then retains all messages and the same response node', async () => {
    fetchContexts.mockResolvedValue([{
      context_node_id: 'reference-1', type: 'result',
      node: { id: 'reference-1', instance_id: 'instance-1', site_id: 'site-1', result: {
        text: 'Source image', outputs: [{ type: 'image', data: { url: 'https://assets.example.test/source.png' } }],
      } },
    }]);
    act.mockImplementationOnce(async invocation => execution(
      [...invocation.messages, toolCall, toolReply], 'Generating the image', [imageStep],
    ));
    const first = await executeAssistantStep([{ role: 'user', content: 'Unrelated old image' }, prompt], null, options);
    const initialMessages = act.mock.calls[0][0].messages;
    expect(initialMessages).toHaveLength(2);
    expect(initialMessages[0].content[0].text).toContain('Source image');
    expect(initialMessages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://assets.example.test/source.png' } });
    expect(initialMessages[1]).toBe(prompt);
    expect(fetchContexts).toHaveBeenCalledWith('prompt-1', { instanceId: 'instance-1', siteId: 'site-1' });
    expect(first).toMatchObject({ isDone: false, executionStatus: 'exhausted', resumable: true,
      continuation: { responseNodeIds: ['response-1'] } });
    expect(nodes['response-1'].result).toMatchObject({ status: 'running', outputs: [imageOutput] });

    act.mockImplementationOnce(async invocation => {
      expect(invocation.messages).toBe(first.messages);
      expect(invocation.messages.slice(-2)).toEqual([toolCall, toolReply]);
      await invocation.onStreamChunk('log-1', 'Finished', true);
      return execution([...invocation.messages, { role: 'assistant', content: 'Finished' }], 'Finished');
    });
    const second = await executeAssistantStep(first.messages, null, { ...options, node_continuation: first.continuation });
    expect(second).toMatchObject({ isDone: true, executionStatus: 'completed', resumable: false,
      continuation: { responseNodeIds: ['response-1'] } });
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(createCallbacks).toHaveBeenCalledTimes(1);
    expect(createBatch).not.toHaveBeenCalled();
    expect(fetchContexts).toHaveBeenCalledTimes(1);
    expect(updateResult.mock.calls.map(([id]) => id)).toEqual(['response-1', 'response-1', 'response-1']);
    expect(updateResult.mock.calls[1][1]).toMatchObject({ status: 'streaming', outputs: [imageOutput] });
    expect(nodes['response-1'].result).toMatchObject({ status: 'done', text: 'Finished', outputs: [imageOutput] });
    for (const [invocation] of act.mock.calls) {
      expect(invocation.maxIterations).toBe(5);
      expect(invocation.toolOverrides).toBe(options.tool_overrides);
    }
    expect(queries.filter(query => !query.payload).slice(-2)).toEqual([
      { table: 'instance_nodes', filters: { id: 'prompt-1', instance_id: 'instance-1', site_id: 'site-1' } },
      { table: 'instance_nodes', filters: { id: 'response-1', instance_id: 'instance-1', site_id: 'site-1', parent_node_id: 'prompt-1', type: 'response' } },
    ]);
    for (const write of queries.filter(query => query.payload)) {
      expect(write.table).toBe('instance_nodes');
      expect(write.filters).toEqual({
        id: 'response-1', parent_node_id: 'prompt-1', type: 'response', instance_id: 'instance-1', site_id: 'site-1',
      });
      expect(write.payload.status).toBe(write.payload.result.status === 'done' ? 'completed' : 'running');
    }
  });

  it.each([
    ['last tool result', [toolCall, toolReply], 'Earlier narration'],
    ['pending tool call', [toolCall], 'Generating the image'],
    ['empty final assistant', [{ role: 'assistant', content: '' }], 'Stale text'],
    ['whitespace assistant', [{ role: 'assistant', content: '  \n ' }], ''],
    ['no messages', [], 'Fabricated final text'],
  ])('does not mark %s complete even when generated outputs exist', async (_label, messages, text) => {
    act.mockResolvedValue(execution(messages as any[], text as string, [imageStep]));
    const result = await executeAssistantStep([prompt], null, options);
    expect(result).toMatchObject({ isDone: false, executionStatus: 'exhausted', resumable: true });
    expect(updateResult).toHaveBeenLastCalledWith('response-1', expect.objectContaining({ status: 'running' }));
    expect(updateResult.mock.calls.some(([, value]) => value.status === 'done')).toBe(false);
  });

  it('uses actual final assistant content when the executor text is empty', async () => {
    act.mockResolvedValue(execution([{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }]));
    const result = await executeAssistantStep([prompt], null, options);
    expect(result.isDone).toBe(true);
    expect(result.text).toBe('Ready');
    expect(updateResult).toHaveBeenLastCalledWith('response-1', { text: 'Ready', status: 'done' });
  });

  it('keeps a final stream fragment streaming until the chunk is actually settled', async () => {
    act.mockImplementation(async invocation => {
      const id = await invocation.onStreamStart();
      await invocation.onStreamChunk(id, 'Calling a tool', true);
      expect(nodes['response-1'].result.status).toBe('streaming');
      return execution([toolCall, toolReply]);
    });
    await executeAssistantStep([prompt], null, options);
    expect(nodes['response-1'].result.status).toBe('running');
    expect(streamChunk).toHaveBeenCalledWith('log-1', 'Calling a tool', true);
  });

  it('retains serialized generated outputs and deduplicates them across chunks', async () => {
    nodes['response-1'].result = JSON.stringify({ outputs: [imageOutput] });
    act.mockResolvedValue(execution([{ role: 'assistant', content: 'Ready' }], 'Ready', [imageStep]));
    await executeAssistantStep([prompt, toolCall, toolReply], null, {
      ...options, node_continuation: { responseNodeIds: ['response-1'] },
    });
    expect(nodes['response-1'].result.outputs).toEqual([imageOutput]);
    expect(createResponse).not.toHaveBeenCalled();
  });

  it('does not treat media placeholders as generated outputs on completion', async () => {
    nodes['response-1'].result = { outputs: [{ ...imageOutput, data: {} }] };
    await executeAssistantStep([prompt], null, { ...options, node_continuation: { responseNodeIds: ['response-1'] } });
    expect(nodes['response-1'].result.outputs).toBeUndefined();
  });
});

describe('scoped node access and continuation identities', () => {
  it.each([
    ['missing prompt', 'prompt-1', null],
    ['foreign-site prompt', 'prompt-1', { site_id: 'site-2' }],
    ['foreign-instance prompt', 'prompt-1', { instance_id: 'instance-2' }],
    ['missing response', 'response-1', null],
    ['foreign-site response', 'response-1', { site_id: 'site-2' }],
    ['foreign-instance response', 'response-1', { instance_id: 'instance-2' }],
    ['wrong response parent', 'response-1', { parent_node_id: 'prompt-2' }],
    ['not a response', 'response-1', { type: 'prompt' }],
    ['cancelled response', 'response-1', { status: 'cancelled' }],
    ['stopped response', 'response-1', { status: 'stopped' }],
  ])('rejects %s without model calls or new nodes', async (_label, id, patch) => {
    nodes[id as string] = patch ? { ...nodes[id as string], ...patch } : null;
    await expect(executeAssistantStep([prompt], null, {
      ...options, node_continuation: { responseNodeIds: ['response-1'] },
    })).rejects.toThrow(/not found in the execution scope/);
    expect(act).not.toHaveBeenCalled();
    expect(createResponse).not.toHaveBeenCalled();
    expect(updateResult).not.toHaveBeenCalled();
  });

  it.each([{ ids: [] }, { ids: [''] }, { ids: ['response-1', 'response-1'] }])('rejects malformed continuation IDs $ids', async ({ ids }) => {
    await expect(executeAssistantStep([prompt], null, {
      ...options, node_continuation: { responseNodeIds: ids },
    })).rejects.toThrow('Only a single response node can be continued');
    expect(act).not.toHaveBeenCalled();
    expect(createResponse).not.toHaveBeenCalled();
  });

  it('requires site/instance scope before node queries', async () => {
    await expect(executeAssistantStep([prompt], null, { instance_node_id: 'prompt-1' }))
      .rejects.toThrow('requires an instance and site scope');
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects continuation without a current node', async () => {
    await expect(executeAssistantStep([prompt], null, { node_continuation: { responseNodeIds: ['response-1'] } }))
      .rejects.toThrow('requires a prompt node');
  });

  it('scopes initial parent references and excludes foreign nodes', async () => {
    nodes['prompt-1'].parent_node_id = 'parent-1';
    nodes['parent-1'] = { id: 'parent-1', instance_id: 'instance-1', site_id: 'site-2', result: { text: 'Secret' } };
    fetchContexts.mockResolvedValue([{ context_node_id: 'parent-1', type: 'result', node: nodes['parent-1'] }]);
    await executeAssistantStep([prompt], null, options);
    expect(act.mock.calls[0][0].messages).toEqual([prompt]);
    expect(queries[1].filters).toEqual({ id: 'parent-1', instance_id: 'instance-1', site_id: 'site-1' });
  });

  it('preserves the implicit parent reference in initial node context', async () => {
    nodes['prompt-1'].parent_node_id = 'parent-1';
    nodes['parent-1'] = { id: 'parent-1', instance_id: 'instance-1', site_id: 'site-1', result: { text: 'Parent asset' } };
    await executeAssistantStep([prompt], null, options);
    expect(act.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: expect.stringContaining('[Reference Context from linked node parent_reference]') }, prompt,
    ]);
    expect(act.mock.calls[0][0].messages[0].content).toContain('Parent asset');
    expect(createCallbacks).toHaveBeenCalledWith('prompt-1', nodes['prompt-1'], [
      { context_node_id: 'parent-1', type: 'parent_reference' },
    ]);
  });

  it('does not call the model if initial response creation fails', async () => {
    createResponse.mockRejectedValueOnce(new Error('Creation failed'));
    await expect(executeAssistantStep([prompt], null, options)).rejects.toThrow('Creation failed');
    expect(act).not.toHaveBeenCalled();
  });

  it('does not overwrite a response cancellation with a late completion', async () => {
    act.mockImplementation(async () => {
      nodes['response-1'].status = 'stopped';
      return execution([{ role: 'assistant', content: 'Late result' }], 'Late result');
    });
    await expect(executeAssistantStep([prompt], null, options)).rejects.toThrow('Unable to persist');
    expect(nodes['response-1'].status).toBe('stopped');
  });

  it('fails closed if the response node disappears before persistence', async () => {
    act.mockImplementationOnce(async () => {
      delete nodes['response-1'];
      return execution([{ role: 'assistant', content: 'Finished' }], 'Finished');
    });
    await expect(executeAssistantStep([prompt], null, options)).rejects.toThrow('Unable to persist the scoped response node');
  });

  it('does not update a response moved to another parent during execution', async () => {
    act.mockImplementationOnce(async () => {
      nodes['response-1'].parent_node_id = 'prompt-2';
      return execution([{ role: 'assistant', content: 'Finished' }], 'Finished');
    });
    await expect(executeAssistantStep([prompt], null, options)).rejects.toThrow('Unable to persist the scoped response node');
    expect(updateResult).not.toHaveBeenCalled();
  });
});

describe('parallel nodes and legacy compatibility', () => {
  it('does not replay partial fan-out and preserves tool overrides in every call', async () => {
    act.mockResolvedValueOnce(execution([{ role: 'assistant', content: 'First completed' }], 'First completed'))
      .mockResolvedValueOnce(execution([toolCall, toolReply], 'Working'));
    const result = await executeAssistantStep([prompt], null, { ...options, expected_results_amount: 2 });
    expect(result).toMatchObject({ isDone: false, executionStatus: 'exhausted', resumable: false,
      continuation: { responseNodeIds: ['response-1', 'response-2'] } });
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(createResponse).not.toHaveBeenCalled();
    for (const [invocation] of act.mock.calls) expect(invocation.toolOverrides).toBe(options.tool_overrides);
    expect(updateResult).toHaveBeenCalledWith('response-1', { text: 'First completed', status: 'done' });
    expect(updateResult).toHaveBeenCalledWith('response-2', { text: 'Working', status: 'running' });
    await expect(executeAssistantStep(result.messages, null, {
      ...options, expected_results_amount: 2, node_continuation: result.continuation,
    })).rejects.toThrow('Only a single response node can be continued');
    expect(act).toHaveBeenCalledTimes(2);
    expect(createBatch).toHaveBeenCalledTimes(1);
  });

  it('only completes fan-out when every branch finishes', async () => {
    const result = await executeAssistantStep([prompt], null, { ...options, expected_results_amount: 2 });
    expect(result).toMatchObject({ isDone: true, executionStatus: 'completed', resumable: false });
  });

  it('pauses instead of replaying fan-out when one branch fails', async () => {
    act.mockRejectedValueOnce(new Error('One branch failed'));
    const result = await executeAssistantStep([prompt], null, { ...options, expected_results_amount: 2 });
    expect(result).toMatchObject({ isDone: false, executionStatus: 'exhausted', resumable: false });
    expect(updateResult).toHaveBeenCalledWith('response-1', { error: 'One branch failed' });
    expect(queries.every(query => query.table === 'instance_nodes')).toBe(true);
  });

  it('still throws when all parallel branches fail', async () => {
    act.mockRejectedValue(new Error('All failed'));
    await expect(executeAssistantStep([prompt], null, { ...options, expected_results_amount: 2 }))
      .rejects.toThrow('All failed');
  });

  it('preserves non-node one-iteration behavior and public exports', async () => {
    act.mockResolvedValue(execution([{ role: 'assistant', content: '' }]));
    const result = await executeAssistantStep([prompt, toolCall, toolReply], null, {});
    expect(result.isDone).toBe(true);
    expect(result.continuation).toBeUndefined();
    expect(act.mock.calls[0][0]).toMatchObject({ maxIterations: 1, messages: [prompt, toolCall, toolReply] });
    expect(from).not.toHaveBeenCalled();
    expect(typeof executeAssistant).toBe('function');
    await expect(prepareAssistantTools(null, { custom_tools: ['tool'] })).resolves.toEqual({ type: 'openai', tools: ['tool'] });
  });

  it('retains the legacy executeAssistant tool options and response contract', async () => {
    const result = await executeAssistant('Legacy prompt', null, {
      custom_tools: ['legacy-tool'], tool_overrides: options.tool_overrides,
    });
    expect(result).toEqual({ text: 'Finished', output: null, steps: [], usage: {} });
    expect(act.mock.calls[0][0]).toMatchObject({
      prompt: 'Legacy prompt', tools: ['legacy-tool'], toolOverrides: options.tool_overrides,
    });
    expect(from).not.toHaveBeenCalled();
  });
});