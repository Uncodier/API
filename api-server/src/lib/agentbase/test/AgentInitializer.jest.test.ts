import { ProcessorInitializer } from '../services/AgentInitializer';
import { Base } from '../agents/Base';

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
    updateCommand: jest.fn().mockResolvedValue({})
  }
}));

describe('ProcessorInitializer', () => {
  let processorInitializer: any;
  let mockProcessor: Partial<Base>;
  
  beforeEach(() => {
    // Get singleton instance
    processorInitializer = ProcessorInitializer.getInstance();
    
    // Create mock processor
    mockProcessor = {
      getId: () => 'test-processor',
      getName: () => 'Test Processor',
      getCapabilities: () => ['test', 'mock'],
      prompt: 'This is a custom agent prompt that should be included in a specific section'
    };
    
    // Add a spy on console.log for verification
    jest.spyOn(console, 'log').mockImplementation();
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('buildAgentPrompt', () => {
    it('should correctly include agentPrompt in the final prompt', () => {
      // Access the private method using any cast
      const buildAgentPrompt = (processorInitializer as any).buildAgentPrompt.bind(processorInitializer);
      
      const result = buildAgentPrompt(
        'test-id',
        'Test Agent',
        'A test agent description',
        ['capability1', 'capability2'],
        'This is the backstory',
        'This is the agent prompt content'
      );
      
      // Verify that agent prompt is included in the result
      expect(result).toContain('# Agent Custom Instructions');
      expect(result).toContain('This is the agent prompt content');
      
      // Verify section order - agent prompt should come before backstory
      const promptIndex = result.indexOf('# Agent Custom Instructions');
      const backstoryIndex = result.indexOf('# Backstory');
      
      expect(promptIndex).toBeGreaterThan(0);
      expect(backstoryIndex).toBeGreaterThan(0);
      expect(promptIndex).toBeLessThan(backstoryIndex);
      
      // Log the generated prompt for debugging
      console.log('Generated prompt structure for testing:');
      console.log(result);
    });
    
    it('should correctly generate prompt when only backstory is provided', () => {
      const buildAgentPrompt = (processorInitializer as any).buildAgentPrompt.bind(processorInitializer);
      
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
      const buildAgentPrompt = (processorInitializer as any).buildAgentPrompt.bind(processorInitializer);
      
      const result = buildAgentPrompt(
        'test-id',
        'Test Agent',
        'A test agent description',
        ['capability1', 'capability2'],
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
      const buildAgentPromptSpy = jest.spyOn(processorInitializer as any, 'buildAgentPrompt');
      
      // Access the private method using any cast
      const generateAgentBackground = (processorInitializer as any).generateAgentBackground.bind(processorInitializer);
      
      // Call the method with our mock processor
      await generateAgentBackground(mockProcessor);
      
      // Verify that buildAgentPrompt was called with the correct prompt from the processor
      expect(buildAgentPromptSpy).toHaveBeenCalledTimes(1);
      
      // Check that the agentPrompt parameter was passed correctly as the 6th argument
      const args = buildAgentPromptSpy.mock.calls[0];
      expect(args[5]).toBe('This is a custom agent prompt that should be included in a specific section');
    });
    
    it('should log what agent.prompt it finds and is using', async () => {
      // Spy on console.log
      const consoleLogSpy = jest.spyOn(console, 'log');
      
      // Access the private method
      const generateAgentBackground = (processorInitializer as any).generateAgentBackground.bind(processorInitializer);
      
      // Call the method with our mock processor
      await generateAgentBackground(mockProcessor);
      
      // Verify that the agent prompt was logged
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Usando prompt personalizado del agente test-processor')
      );
    });
    
    it('should correctly extract and use agent prompt from DB', async () => {
      // Spy on both buildAgentPrompt and console.log
      const buildAgentPromptSpy = jest.spyOn(processorInitializer as any, 'buildAgentPrompt');
      const consoleLogSpy = jest.spyOn(console, 'log');
      
      // Access the private method
      const generateAgentBackground = (processorInitializer as any).generateAgentBackground.bind(processorInitializer);
      
      // Call with a DB agent ID
      await generateAgentBackground(mockProcessor, 'test-agent-id');
      
      // Verify that the prompt from DB was used
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Usando prompt específico de la base de datos')
      );
      
      // Verify buildAgentPrompt was called with DB prompt
      const args = buildAgentPromptSpy.mock.calls[0];
      expect(args[5]).toBe('This is a specific agent prompt that should be included in Agent Custom Instructions section');
    });
  });
}); 