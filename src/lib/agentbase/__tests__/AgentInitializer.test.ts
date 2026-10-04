import { AgentBackgroundService } from '../services/agent/AgentBackgroundService';
import { BackgroundBuilder } from '../services/agent/BackgroundServices/BackgroundBuilder';
import { Base } from '../agents/Base';
import type { CommandExecutionResult, DbCommand } from '../models/types';

class PromptTestAgent extends Base {
  readonly description = 'A test processor for unit tests';
  readonly prompt = 'This is a custom agent prompt that should be included in a specific section';

  constructor() {
    super('test-processor', 'Test Processor', ['test', 'mock']);
  }

  async executeCommand(_command: DbCommand): Promise<CommandExecutionResult> {
    return { status: 'completed', results: [] };
  }
}

jest.mock('../adapters/DatabaseAdapter', () => ({ DatabaseAdapter: {} }));
jest.mock('@/lib/timezone', () => ({
  ...jest.requireActual<typeof import('@/lib/timezone')>('@/lib/timezone'),
  resolveClientTimezone: jest.fn(async () => 'UTC'),
}));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/utils/redis-client', () => ({ getRedisClient: jest.fn(() => null) }));

describe('Agent background construction', () => {
  let processorInitializer: AgentBackgroundService;
  let mockProcessor: PromptTestAgent;

  beforeEach(() => {
    processorInitializer = new AgentBackgroundService();
    
    // Create mock processor
    mockProcessor = new PromptTestAgent();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('buildAgentPrompt', () => {
    it('should correctly include agentPrompt in the final prompt', () => {
      const buildAgentPrompt = BackgroundBuilder.buildAgentPrompt.bind(BackgroundBuilder);
      
      const result = buildAgentPrompt(
        'test-id',
        'Test Agent',
        'A test agent description',
        ['capability1', 'capability2'],
        'This is the backstory',
        undefined,
        'This is the agent prompt content'
      );
      
      // Verify that agent prompt is included in the result
      expect(result).toContain('# Agent Custom Instructions');
      expect(result).toContain('This is the agent prompt content');
      
      // The current builder establishes backstory before custom instructions.
      const promptIndex = result.indexOf('# Agent Custom Instructions');
      const backstoryIndex = result.indexOf('# Backstory');
      
      expect(promptIndex).toBeGreaterThan(0);
      expect(backstoryIndex).toBeGreaterThan(0);
      expect(backstoryIndex).toBeLessThan(promptIndex);
      
      console.log('Generated prompt structure for testing:');
      console.log(result);
    });
    
    it('should correctly generate prompt when only backstory is provided', () => {
      const buildAgentPrompt = BackgroundBuilder.buildAgentPrompt.bind(BackgroundBuilder);
      
      const result = buildAgentPrompt(
        'test-id',
        'Test Agent',
        'A test agent description',
        ['capability1', 'capability2'],
        'This is the backstory',
        undefined
      );
      
      // Verify that backstory is included correctly
      expect(result).toContain('# Backstory');
      expect(result).toContain('This is the backstory');
      
      // Agent prompt section should not be included
      expect(result).not.toContain('# Agent Custom Instructions');
    });
    
    it('should correctly generate prompt when only agentPrompt is provided', () => {
      const buildAgentPrompt = BackgroundBuilder.buildAgentPrompt.bind(BackgroundBuilder);
      
      const result = buildAgentPrompt(
        'test-id',
        'Test Agent',
        'A test agent description',
        ['capability1', 'capability2'],
        undefined,
        undefined,
        'This is the agent prompt content'
      );
      
      // Verify that agent prompt is included correctly
      expect(result).toContain('# Agent Custom Instructions');
      expect(result).toContain('This is the agent prompt content');
      
      // Backstory section should not be included
      expect(result).not.toContain('# Backstory');
    });
  });

  describe('generateAgentBackground', () => {
    it('should correctly extract and use agentPrompt from processor', async () => {
      // Create a spy on buildAgentPrompt to verify its arguments
      const buildAgentPromptSpy = jest.spyOn(BackgroundBuilder, 'buildAgentPrompt');
      
      const generateAgentBackground = processorInitializer.generateAgentBackground.bind(processorInitializer);
      
      // Call the method with our mock processor
      await generateAgentBackground(mockProcessor);
      
      // Verify that buildAgentPrompt was called with the correct prompt from the processor
      expect(buildAgentPromptSpy).toHaveBeenCalledTimes(1);
      
      // Check that the agentPrompt parameter was passed correctly
      const args = buildAgentPromptSpy.mock.calls[0];
      expect(args[6]).toBe('This is a custom agent prompt that should be included in a specific section');
    });
  });
}); 