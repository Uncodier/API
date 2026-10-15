import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

// Execute the real wrappers with explicit offline dependencies; no application/env setup.
class OfflineBase {
  constructor(readonly id: string, readonly name: string, readonly capabilities: string[] = []) {}
  extractTokenUsage() { return { inputTokens: 0, outputTokens: 0 }; }
}
const routing = { getOpenRouterChatModel: () => 'openai/offline-model',
  isOpenRouterReasoningModel: () => false, resolveOpenRouterModel: () => 'openai/offline-model' };
const parseTargetResponseContent = jest.fn();
const executeSelectedTools = jest.fn();
const cacheCommand = jest.fn();
const monitor = { startMonitoring: jest.fn(), recordError: jest.fn(), completeMonitoring: jest.fn(),
  recordTimeout: jest.fn(), recordChunk: jest.fn() };
const loadStreamingProcessor = () => loadRuntimeModule<typeof import('../../../agents/streaming/StreamingResponseProcessor')>(
  'src/lib/agentbase/agents/streaming/StreamingResponseProcessor.ts', {
    '../../models/types': {}, '../../services/command/CommandCache': { CommandCache: { cacheCommand } },
    '../../utils/StreamingMonitor': { StreamingMonitor: monitor },
  },
);
let StreamingResponseProcessor: ReturnType<typeof loadStreamingProcessor>['StreamingResponseProcessor'];
const { AgentConnector } = loadRuntimeModule<typeof import('../../../agents/AgentConnector')>(
  'src/lib/agentbase/agents/AgentConnector.ts', {
    './Base': { Base: OfflineBase }, '../services/PortkeyConnector': {}, '../models/types': {},
    '../models/model-selection': {}, '@/lib/services/ai/openrouter': routing,
  },
);
const { ToolEvaluator } = loadRuntimeModule<typeof import('../../../agents/toolEvaluator/index')>(
  'src/lib/agentbase/agents/toolEvaluator/index.ts', {
    '../Base': { Base: OfflineBase }, '../../services/PortkeyConnector': {}, '../../models/types': {},
    '../../models/model-selection': {}, '@/lib/services/ai/openrouter': routing,
    '../../prompts/tool-evaluator-prompt': { TOOL_EVALUATOR_SYSTEM_PROMPT: 'Offline instructions' },
    './tokenUtils': {}, './responseProcessor': {},
    './messageFormatter': { validateAndNormalizeTools: (tools: unknown) => tools,
      prepareMessagesFromCommand: () => [{ role: 'system', content: 'Offline instructions' }] },
    './types': {}, '../../services/command/CommandCache': {}, '../../services/command/CommandService': {},
    './executor/runner': { executeSelectedTools }, './executor/dottedToolName': {},
    './executor': {}, './updater': {},
  },
);
const { TargetProcessor } = loadRuntimeModule<typeof import('../../../agents/TargetProcessor')>(
  'src/lib/agentbase/agents/TargetProcessor.ts', {
    './Base': { Base: OfflineBase }, '../services/PortkeyConnector': {}, '../models/types': {},
    '../models/model-selection': {}, '@/lib/services/ai/openrouter': routing,
    '../prompts/target-processor-prompt': { TARGET_PROCESSOR_SYSTEM_PROMPT: 'Offline instructions',
      formatTargetProcessorPrompt: () => 'Offline target prompt' },
    './targetEvaluator/formatters/target-message-formatter': { prepareMessagesForTarget: () => [] },
    './toolEvaluator/tokenUtils': { extractTokenUsage: () => ({ inputTokens: 0, outputTokens: 0 }) },
    '../services/command/CommandCache': {}, '../adapters/DatabaseAdapter': {},
    './streaming/StreamingResponseProcessor': { StreamingResponseProcessor: {
      processStreamingResponse: (...args: Parameters<typeof StreamingResponseProcessor.processStreamingResponse>) =>
        StreamingResponseProcessor.processStreamingResponse(...args),
    } },
    './targetEvaluator/parseTargetResponse': { parseTargetResponseContent },
    './targetEvaluator/schemaRetry': { MAX_PARSE_RETRIES: 3, schemaRetryUserMessage: () => 'Retry' },
  },
);
const { runToolCompletionLoop } = loadRuntimeModule<typeof import('../tool-completion-loop')>(
  'src/lib/agentbase/services/command/tool-completion-loop.ts', {
    './tool-loop-context': { buildToolTurnContext: () => 'Offline context' },
  },
);
const { CommandProcessor } = loadRuntimeModule<typeof import('../CommandProcessor')>(
  'src/lib/agentbase/services/command/CommandProcessor.ts', {
    './CommandService': {}, '../../agents/Base': {}, '../../models/types': {},
    '../../agents/ToolEvaluator': {}, '../../agents/TargetProcessor': {},
    '../../adapters/DatabaseAdapter': {}, './CommandCache': {}, './CommandStore': {},
    '../agent/AgentBackgroundService': { AgentBackgroundService: class {} },
    './tool-completion-loop': { runToolCompletionLoop },
    './initialize-agent': { initializeAgentCommand: async (command: unknown) => command },
    '../../utils/composioIntegration': { isComposioEnabled: () => false },
  },
);
const command = { id: 'command-offline', site_id: 'site-offline', task: 'Answer', agent_background: 'Host instructions',
  tools: [{ name: 'lookup' }], targets: [{ name: 'answer' }], metadata: { stream: false } };
const billingFailure = () => Object.assign(new Error('billing requires reconciliation'), { name: 'OpenRouterBillingError' });

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  ({ StreamingResponseProcessor } = loadStreamingProcessor());
  for (const method of ['log', 'warn', 'error'] as const) jest.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

it.each(['agent', 'tools', 'targets'])('preserves terminal billing identity through %s catches without a new generation', async kind => {
  // Even provider-shaped messages must not enter the legacy rate-limit failure-result path.
  const failure = Object.assign(billingFailure(), { message: 'Rate limit exceeded; billing requires reconciliation' });
  const connector = { callAgent: jest.fn().mockRejectedValue(failure) };
  const agent = kind === 'tools' ? new ToolEvaluator('tools', 'Tools', connector as any)
    : kind === 'targets' ? new TargetProcessor('targets', 'Targets', connector as any)
      : new AgentConnector('agent', 'Agent', connector as any);
  await expect(agent.executeCommand({ ...command, ...(kind === 'agent' ? { tools: [] } : {}) } as any)).rejects.toBe(failure);
  expect(connector.callAgent).toHaveBeenCalledTimes(1);
  expect(executeSelectedTools).not.toHaveBeenCalled();
  expect(parseTargetResponseContent).not.toHaveBeenCalled();
});

it('does not retry target schema generation after a later completion billing failure', async () => {
  const failure = billingFailure();
  parseTargetResponseContent.mockReturnValue({ ok: false, error: 'Invalid JSON' });
  const connector = { callAgent: jest.fn().mockResolvedValueOnce({ content: 'Invalid JSON' }).mockRejectedValueOnce(failure) };
  const agent = new TargetProcessor('targets', 'Targets', connector as any);
  await expect(agent.executeCommand({ ...command } as any)).rejects.toBe(failure);
  expect(connector.callAgent).toHaveBeenCalledTimes(2);
  expect(parseTargetResponseContent).toHaveBeenCalledTimes(1);
});

it('rejects stream billing failure instead of emitting any successful final callback', async () => {
  const failure = billingFailure();
  const stream = (async function* () {
    yield { choices: [{ delta: { content: 'Partial' } }] };
    throw failure;
  })();
  const callback = jest.fn();
  const agent = new AgentConnector('agent', 'Agent', {} as any);
  await expect(agent.processStream(stream, callback)).rejects.toBe(failure);
  expect(callback.mock.calls).toEqual([['Partial', false]]);
});

it.each(['processor', 'target'])('rejects %s partial streaming billing without recovery, caching success or parsing', async path => {
  // The real legacy processor's watchdog uses global intervals in its VM context.
  jest.useFakeTimers();
  const failure = Object.assign(billingFailure(), { code: 'UND_ERR_SOCKET', partialContent: 'Recoverable prose'.repeat(20) });
  const next = jest.fn().mockResolvedValueOnce({ done: false, value: { choices: [{ delta: { content: failure.partialContent } }] } })
    .mockRejectedValueOnce(failure);
  const stream = { [Symbol.asyncIterator]: () => ({ next }) };
  const fill = jest.fn();
  const connector = { callAgent: jest.fn().mockResolvedValue({ isStream: true, stream }) };
  const result = path === 'target' ? new TargetProcessor('targets', 'Targets', connector as any).executeCommand({ ...command } as any)
    : StreamingResponseProcessor.processStreamingResponse(stream, { ...command } as any, {}, fill);
  await expect(result).rejects.toBe(failure);
  expect(next).toHaveBeenCalledTimes(2);
  expect(fill).not.toHaveBeenCalled();
  expect(cacheCommand).not.toHaveBeenCalled();
  expect(parseTargetResponseContent).not.toHaveBeenCalled();
  expect((StreamingResponseProcessor as any).activeStreams.size).toBe(0);
  expect((StreamingResponseProcessor as any).commandLocks.size).toBe(0);
});

it('never falls back from SSE to async iteration after terminal billing failure', async () => {
  jest.useFakeTimers();
  const failure = billingFailure();
  const iterate = jest.fn();
  const stream: any = { [Symbol.asyncIterator]: iterate, on(event: string, listener: (...args: any[]) => void) {
    if (event === 'error') listener(failure);
    return this;
  } };
  await expect(StreamingResponseProcessor.processStreamingResponse(stream, { ...command } as any, {}, jest.fn())).rejects.toBe(failure);
  expect(iterate).not.toHaveBeenCalled();
  expect(cacheCommand).not.toHaveBeenCalled();
});

it('rejects terminal billing errors raised while processing SSE data rather than swallowing them', async () => {
  const failure = billingFailure();
  const chunk = Object.defineProperty({}, 'choices', { get() { throw failure; } });
  const stream = { read() {}, on(event: string, listener: (...args: any[]) => void) {
    if (event === 'data') listener(chunk);
    return this;
  } };
  await expect(StreamingResponseProcessor.processStreamingResponse(stream, { ...command } as any, {}, jest.fn())).rejects.toBe(failure);
  expect(cacheCommand).not.toHaveBeenCalled();
});

it('stops the real command/tool completion loop before tools, targets or another generation', async () => {
  const failure = billingFailure();
  const connector = { callAgent: jest.fn().mockRejectedValue(failure) };
  const evaluator = new ToolEvaluator('tools', 'Tools', connector as any);
  const targets = { executeCommand: jest.fn() };
  const service = { updateStatus: jest.fn().mockResolvedValue(undefined), getCommandById: jest.fn() };
  const processor = new CommandProcessor(service as any, { tool_evaluator: evaluator, target_processor: targets });
  const result = await processor.processCommand({ ...command } as any);
  expect(result.status).toBe('failed');
  expect(result.error).toBe(failure.message);
  expect(connector.callAgent).toHaveBeenCalledTimes(1);
  expect(targets.executeCommand).not.toHaveBeenCalled();
  expect(executeSelectedTools).not.toHaveBeenCalled();
  expect(service.getCommandById).not.toHaveBeenCalled();
});

it.each(['agent', 'tools', 'targets'])('preserves ordinary failure-result behavior for %s', async kind => {
  const connector = { callAgent: jest.fn().mockRejectedValue(new Error('Ordinary provider failure')) };
  const agent = kind === 'tools' ? new ToolEvaluator('tools', 'Tools', connector as any)
    : kind === 'targets' ? new TargetProcessor('targets', 'Targets', connector as any)
      : new AgentConnector('agent', 'Agent', connector as any);
  await expect(agent.executeCommand({ ...command, ...(kind === 'agent' ? { tools: [] } : {}) } as any)).resolves.toMatchObject({ status: 'failed' });
});

it('preserves ordinary stream error callback behavior', async () => {
  const callback = jest.fn();
  const agent = new AgentConnector('agent', 'Agent', {} as any);
  await agent.processStream((async function* () { throw new Error('Ordinary stream failure'); })(), callback);
  expect(callback).toHaveBeenCalledWith('Error: Ordinary stream failure', true);
});