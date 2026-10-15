import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

const runToolCompletionLoop = jest.fn();
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

beforeEach(() => {
  jest.clearAllMocks();
  for (const method of ['log', 'warn', 'error'] as const) jest.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('marks a command failed after terminal generation billing without continuing to target inference', async () => {
  const failure = Object.assign(new Error('billing requires reconciliation'), { name: 'OpenRouterBillingError' });
  runToolCompletionLoop.mockRejectedValueOnce(failure);
  const commandService = { updateStatus: jest.fn().mockResolvedValue(undefined) };
  const targets = { process: jest.fn() };
  const processor = new CommandProcessor(commandService as any, { tool_evaluator: {}, target_processor: targets });
  const result = await processor.processCommand({ id: 'command-offline', site_id: 'site-offline',
    agent_background: 'Host instructions', tools: [{ name: 'lookup' }], targets: [{ name: 'answer' }] } as any);
  expect(result.status).toBe('failed');
  expect(result.error).toBe('billing requires reconciliation');
  expect(commandService.updateStatus).toHaveBeenCalledWith('command-offline', 'failed', 'billing requires reconciliation');
  expect(runToolCompletionLoop).toHaveBeenCalledTimes(1);
  expect(targets.process).not.toHaveBeenCalled();
});