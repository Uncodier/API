/**
 * Tests for the ToolEvaluator class with dual system prompts
 */
import { ToolEvaluator } from '../ToolEvaluator';
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

describe('ToolEvaluator', () => {
  let evaluator: ToolEvaluator;
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
    tools: [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'The city and state/country'
            }
          },
          required: ['location']
        }
      }
    ]
  } as unknown as DbCommand;
  
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    
    // Create a mock connector with a mock implementation
    mockConnector = {
      callAgent: jest.fn().mockResolvedValue({
        content: JSON.stringify([
          {
            id: 'call_12345xyz',
            type: 'function',
            status: 'initialized',
            function: {
              name: 'get_weather',
              arguments: '{"location":"Paris, France"}'
            }
          }
        ]),
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50
        }
      })
    } as unknown as jest.Mocked<PortkeyConnector>;
    
    // Create an evaluator with both system prompts
    evaluator = new ToolEvaluator(
      'test-evaluator-id',
      'Test Evaluator',
      mockConnector,
      ['tool_evaluation'],
      {
        modelType: 'openai',
        modelId: 'gpt-5-nano',
        temperature: 0.1
      },
      'Tool evaluator description',
      'Primary system prompt for tool evaluation',
      'Agent-specific system prompt'
    );
  });
  
  test('should initialize with both system prompts', () => {
    expect(evaluator.systemPrompt).toBe('Primary system prompt for tool evaluation');
    expect(evaluator.agentSystemPrompt).toBe('Agent-specific system prompt');
  });
  
  test('should execute command with both system prompts', async () => {
    const result = await evaluator.executeCommand(mockCommand);
    
    // Verify connector was called
    expect(mockConnector.callAgent).toHaveBeenCalled();
    
    // Verify the first argument (messages) containing both system prompts
    const messages = mockConnector.callAgent.mock.calls[0][0];
    
    // The system message should contain all three: agent_background, agentSystemPrompt, and systemPrompt
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('# Agent Identity');
    expect(messages[0].content).toContain('Agent-specific system prompt');
    expect(messages[0].content).toContain('Primary system prompt for tool evaluation');
    
    // Verify result is correct
    expect(result.status).toBe('completed');
    if (result.results) {
      expect(result.results[0].type).toBe('tool_evaluation');
      expect(result.results[0].content.message).toBe('Tool evaluation completed');
    }
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });
  
  test('should work with only the primary system prompt', async () => {
    // Create an evaluator with only the primary system prompt
    const evaluatorWithOnePrimary = new ToolEvaluator(
      'test-evaluator-id-2',
      'Test Evaluator 2',
      mockConnector,
      ['tool_evaluation'],
      {
        modelType: 'openai',
        modelId: 'gpt-5-nano',
        temperature: 0.1
      },
      'Tool evaluator description',
      'Primary system prompt only'
    );
    
    const result = await evaluatorWithOnePrimary.executeCommand(mockCommand);
    
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
    // Create an evaluator with only the agent system prompt
    const evaluatorWithOneAgent = new ToolEvaluator(
      'test-evaluator-id-3',
      'Test Evaluator 3',
      mockConnector,
      ['tool_evaluation'],
      {
        modelType: 'openai',
        modelId: 'gpt-5-nano',
        temperature: 0.1
      },
      'Tool evaluator description',
      undefined,
      'Agent-specific system prompt only'
    );
    
    const result = await evaluatorWithOneAgent.executeCommand(mockCommand);
    
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