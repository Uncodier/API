/**
 * Tests for the TargetProcessor class with dual system prompts
 */
import { TargetProcessor } from '../TargetProcessor';
import { PortkeyConnector } from '../../services/PortkeyConnector';
import { DbCommand } from '../../models/types';

// Mock the PortkeyConnector
jest.mock('../../services/PortkeyConnector');
jest.mock('../../services/command/CommandCache', () => ({
  CommandCache: {
    getCachedCommand: jest.fn(),
    setAgentBackground: jest.fn()
  }
}));
jest.mock('../../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    verifyAgentBackground: jest.fn()
  }
}));

describe('TargetProcessor', () => {
  let processor: TargetProcessor;
  let mockConnector: jest.Mocked<PortkeyConnector>;
  
  // Mock command with minimum required properties for testing
  const mockCommand = {
    id: 'test-command-id',
    task: 'test-task',
    status: 'pending',
    agent_id: 'test-agent-id',
    agent_background: '# Agent Identity\nYou are a helpful assistant.',
    user_id: 'test-user-id',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    targets: [
      {
        type: 'text',
        content: ''
      }
    ]
  } as unknown as DbCommand;
  
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    
    // Create a mock connector with a mock implementation
    mockConnector = {
      callAgent: jest.fn().mockResolvedValue({
        content: 'Mock response content',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50
        }
      })
    } as unknown as jest.Mocked<PortkeyConnector>;
    
    // Create a processor with both system prompts
    processor = new TargetProcessor(
      'test-processor-id',
      'Test Processor',
      mockConnector,
      ['target_processing'],
      {
        modelType: 'openai',
        modelId: 'gpt-5-nano',
        temperature: 0.1
      },
      'Primary system prompt for target processing',
      'Agent-specific system prompt'
    );
  });
  
  test('should initialize with both system prompts', () => {
    expect(processor.systemPrompt).toBe('Primary system prompt for target processing');
    expect(processor.agentSystemPrompt).toBe('Agent-specific system prompt');
  });
  
  test('should execute command with both system prompts', async () => {
    const result = await processor.executeCommand(mockCommand);
    
    // Verify connector was called
    expect(mockConnector.callAgent).toHaveBeenCalled();
    
    // Verify the first argument (messages) containing both system prompts
    const messages = mockConnector.callAgent.mock.calls[0][0];
    
    // The system message should contain all three: agent_background, agentSystemPrompt, and systemPrompt
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('# Agent Identity');
    expect(messages[0].content).toContain('Agent-specific system prompt');
    expect(messages[0].content).toContain('Primary system prompt for target processing');
    
    // Verify result is correct
    expect(result.status).toBe('completed');
    if (result.results) {
      expect(result.results[0].type).toBe('text');
      expect(result.results[0].content).toBe('Mock response content');
    }
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });
  
  test('should work with only the primary system prompt', async () => {
    // Create a processor with only the primary system prompt
    const processorWithOnePrimary = new TargetProcessor(
      'test-processor-id-2',
      'Test Processor 2',
      mockConnector,
      ['target_processing'],
      {
        modelType: 'openai',
        modelId: 'gpt-5-nano',
        temperature: 0.1
      },
      'Primary system prompt only'
    );
    
    const result = await processorWithOnePrimary.executeCommand(mockCommand);
    
    // Verify connector was called
    expect(mockConnector.callAgent).toHaveBeenCalled();
    
    // Verify the first argument (messages) containing only the primary system prompt
    const messages = mockConnector.callAgent.mock.calls[0][0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('# Agent Identity');
    expect(messages[0].content).toContain('Primary system prompt only');
    expect(messages[0].content).not.toContain('Agent-specific system prompt');
    
    // Verify result is correct
    expect(result.status).toBe('completed');
  });
  
  test('should work with only the agent system prompt', async () => {
    // Create a processor with only the agent system prompt
    const processorWithOneAgent = new TargetProcessor(
      'test-processor-id-3',
      'Test Processor 3',
      mockConnector,
      ['target_processing'],
      {
        modelType: 'openai',
        modelId: 'gpt-5-nano',
        temperature: 0.1
      },
      undefined,
      'Agent-specific system prompt only'
    );
    
    const result = await processorWithOneAgent.executeCommand(mockCommand);
    
    // Verify connector was called
    expect(mockConnector.callAgent).toHaveBeenCalled();
    
    // Verify the first argument (messages) containing only the agent system prompt
    const messages = mockConnector.callAgent.mock.calls[0][0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('# Agent Identity');
    expect(messages[0].content).toContain('Agent-specific system prompt only');
    expect(messages[0].content).not.toContain('Primary system prompt');
    
    // Verify result is correct
    expect(result.status).toBe('completed');
  });
}); 