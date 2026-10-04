import { AgentInitializer } from '../services/agent/AgentInitializer';
import { AgentBackgroundService } from '../services/agent/AgentBackgroundService';
import { CommandService } from '../services/command/CommandService';
import { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import type { CommandExecutionResult, DbCommand } from '../models/types';
import type CommandProcessor from '../services/command/CommandProcessor';
import { Base } from '../agents/Base';

class PromptTestAgent extends Base {
  constructor() {
    super('test-processor', 'Test Processor', ['test', 'mock']);
  }

  async executeCommand(_command: DbCommand): Promise<CommandExecutionResult> {
    return { status: 'completed', results: [] };
  }
}

const mockProcessCommand = jest.fn<ReturnType<CommandProcessor['processCommand']>, Parameters<CommandProcessor['processCommand']>>();

// Keep prompt generation real, but stop before any provider, database or Redis IO.
jest.mock('../services/command/CommandProcessor', () => ({
  __esModule: true,
  default: jest.fn(() => ({ processCommand: mockProcessCommand })),
}));
jest.mock('../services/processor/ProcessorConfigurationService', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    configureProcessors: () => ({ tool_evaluator: new PromptTestAgent() }),
  })),
}));
jest.mock('../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    isValidUUID: jest.fn(() => true),
    getAgentById: jest.fn(async () => ({
      id: 'test-agent-id',
      name: 'Test Agent',
      configuration: {
        capabilities: ['test', 'prompt_testing'],
        description: 'An agent for testing prompts',
        prompt: 'This is a specific agent prompt that should be included in Agent Custom Instructions section',
      },
    })),
    getAgentFiles: jest.fn(async () => []),
    getAgentTools: jest.fn(async () => []),
    updateCommand: jest.fn(async () => null),
    getCommandById: jest.fn(async () => null),
  },
}));
jest.mock('../services/agent/AgentCacheService', () => ({
  AgentCacheService: jest.fn(() => ({
    getAgentData: jest.fn(async () => null),
    setAgentData: jest.fn(async () => undefined),
  })),
}));
jest.mock('@/lib/timezone', () => ({
  ...jest.requireActual<typeof import('@/lib/timezone')>('@/lib/timezone'),
  resolveClientTimezone: jest.fn(async () => 'UTC'),
}));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/utils/redis-client', () => ({ getRedisClient: jest.fn(() => null) }));
jest.mock('uuid', () => ({ v4: jest.fn(() => '00000000-0000-4000-8000-000000000001') }));

function command(overrides: Partial<DbCommand> = {}): DbCommand {
  return {
    id: 'test-command-id',
    task: 'test',
    status: 'pending',
    user_id: 'test-user-id',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    agent_id: 'test-agent-id',
    targets: [{ type: 'text', content: 'Test content' }],
    metadata: { dbUuid: 'test-db-uuid' },
    ...overrides,
  };
}

describe('AgentPrompt Integration Tests', () => {
  let commandService: CommandService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessCommand.mockImplementation(async value => value);
    const initializer = AgentInitializer.createAndInitialize();
    commandService = initializer.getCommandService();
  });

  afterEach(() => jest.restoreAllMocks());

  // EventEmitter does not await asynchronous listeners. Await their actual work
  // directly instead of relying on an arbitrary timer or starting live workers.
  async function dispatchCreated(value: DbCommand) {
    const listeners = commandService.getEventEmitter().listeners('commandCreated');
    expect(listeners).toHaveLength(1);
    await Promise.all(listeners.map(listener => listener(value)));
  }

  it('should correctly include agent prompt in agent_background when processing command', async () => {
    const generateAgentBackgroundSpy = jest.spyOn(AgentBackgroundService.prototype, 'generateAgentBackground');
    await dispatchCreated(command());

    expect(generateAgentBackgroundSpy).toHaveBeenCalledWith(expect.any(PromptTestAgent), 'test-agent-id', 'test-command-id');
    const generatedBackground = await generateAgentBackgroundSpy.mock.results[0].value;
    expect(generatedBackground).toContain('# Agent Custom Instructions');
    expect(generatedBackground).toContain('This is a specific agent prompt that should be included');

    // The current handler persists through DatabaseAdapter, then forwards the
    // same background to CommandProcessor.
    expect(DatabaseAdapter.updateCommand).toHaveBeenCalledWith('test-command-id', expect.objectContaining({
      agent_background: expect.any(String),
    }));
    const updateArg = jest.mocked(DatabaseAdapter.updateCommand).mock.calls[0][1];
    expect(updateArg.agent_background).toContain('# Agent Custom Instructions');
    expect(mockProcessCommand).toHaveBeenCalledWith(expect.objectContaining({ agent_background: generatedBackground }));
  });

  it('preserves the exact existing prompt passed to command processing without regenerating it', async () => {
    const generateBackgroundSpy = jest.spyOn(AgentBackgroundService.prototype, 'generateEnhancedAgentBackground');
    const value = command({ agent_background: '# Test agent background with custom prompt' });
    await dispatchCreated(value);

    expect(generateBackgroundSpy).not.toHaveBeenCalled();
    expect(DatabaseAdapter.updateCommand).not.toHaveBeenCalled();
    expect(mockProcessCommand).toHaveBeenCalledTimes(1);
    expect(mockProcessCommand).toHaveBeenCalledWith(expect.objectContaining({ agent_background: value.agent_background }));
  });
});