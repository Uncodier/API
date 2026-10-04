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

jest.mock('@/lib/timezone', () => ({
  ...jest.requireActual<typeof import('@/lib/timezone')>('@/lib/timezone'),
  resolveClientTimezone: jest.fn(async () => 'UTC'),
}));
jest.mock('../services/agent/AgentCacheService', () => ({
  AgentCacheService: jest.fn(() => ({
    getAgentData: jest.fn(async () => null),
    setAgentData: jest.fn(async () => undefined),
  })),
}));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/utils/redis-client', () => ({ getRedisClient: jest.fn(() => null) }));

// Mock dependencies
jest.mock('../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    isValidUUID: jest.fn().mockReturnValue(true),
    getAgentById: jest.fn().mockResolvedValue({
      id: 'test-agent-id',
      name: 'Test Agent',
      configuration: {
        capabilities: ['test', 'prompt_testing'],
        description: 'An agent for testing prompts',
        prompt: 'This is a specific agent prompt that should be included in Agent Custom Instructions section'
      }
    }),
    getAgentFiles: jest.fn().mockResolvedValue([]),
    getAgentTools: jest.fn().mockResolvedValue([]),
    updateCommand: jest.fn().mockResolvedValue({})
  }
}));

describe('Agent background construction', () => {
  let processorInitializer: AgentBackgroundService;
  let mockProcessor: PromptTestAgent;
  
  beforeEach(() => {
    processorInitializer = new AgentBackgroundService();
    
    // Create mock processor
    mockProcessor = new PromptTestAgent();
    
    // Add a spy on console.log for verification
    jest.spyOn(console, 'log').mockImplementation();
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
      
      // Log the generated prompt for debugging
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
      
      // The current builder accepts systemPrompt before agentPrompt.
      const args = buildAgentPromptSpy.mock.calls[0];
      expect(args[6]).toBe('This is a custom agent prompt that should be included in a specific section');
    });
    
    it('should log what agent.prompt it finds and is using', async () => {
      // Spy on console.log
      const consoleLogSpy = jest.spyOn(console, 'log');
      
      // Access the private method
      const generateAgentBackground = processorInitializer.generateAgentBackground.bind(processorInitializer);
      
      // Call the method with our mock processor
      await generateAgentBackground(mockProcessor);
      
      // Verify that the agent prompt was logged
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DataFetcher] Extrayendo prompt del procesador')
      );
    });
    
    it('should correctly extract and use agent prompt from DB', async () => {
      // Spy on both buildAgentPrompt and console.log
      const buildAgentPromptSpy = jest.spyOn(BackgroundBuilder, 'buildAgentPrompt');
      const consoleLogSpy = jest.spyOn(console, 'log');
      
      // Access the private method
      const generateAgentBackground = processorInitializer.generateAgentBackground.bind(processorInitializer);
      
      // Call with a DB agent ID
      await generateAgentBackground(mockProcessor, 'test-agent-id');
      
      // Verify that the prompt from DB was used
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DataFetcher] Encontrado prompt en config')
      );
      
      // Verify buildAgentPrompt was called with DB prompt
      const args = buildAgentPromptSpy.mock.calls[0];
      expect(args[6]).toBe('This is a specific agent prompt that should be included in Agent Custom Instructions section');
    });
  });
}); 