/**
 * Test for TargetProcessorAgent
 * Validates the behavior of the agent when processing targets with both valid and invalid structures
 */

import { TargetProcessorAgent } from '../TargetProcessorAgent';
import { PortkeyAgentConnector } from '../../services/PortkeyAgentConnector';
import { DbCommand, CommandStatus } from '../../models/types';

// Mock the PortkeyAgentConnector
jest.mock('../../services/PortkeyAgentConnector', () => {
  return {
    PortkeyAgentConnector: jest.fn().mockImplementation(() => {
      return {
        callAgent: jest.fn()
      };
    })
  };
});

describe('TargetProcessorAgent', () => {
  let agent: TargetProcessorAgent;
  let connector: PortkeyAgentConnector;

  beforeEach(() => {
    // Reset the mock between tests
    jest.clearAllMocks();
    
    connector = new PortkeyAgentConnector({ apiKey: 'test-key', virtualKeys: {} });
    agent = new TargetProcessorAgent('test_id', 'Test Agent', connector);
  });

  test('should handle empty targets correctly', async () => {
    const command: DbCommand = {
      id: 'test-command-1',
      task: 'test task',
      status: 'running' as CommandStatus,
      user_id: 'test-user',
      created_at: '2023-01-01',
      updated_at: '2023-01-01',
      targets: []
    };

    const result = await agent.executeCommand(command);
    
    expect(result.status).toBe('completed');
    expect(result.results).toBeDefined();
    if (result.results) {
      expect(result.results).toHaveLength(1);
      expect(result.results[0].type).toBe('target_processing');
      expect(result.results[0].content.message).toBe('No targets to process');
    }
  });

  test('should process valid targets successfully', async () => {
    // Mock the connector to return a valid response
    (connector.callAgent as jest.Mock).mockResolvedValue({
      content: [
        {
          type: 'contents',
          contents: [
            {
              type: 'blog_post',
              text: 'This is a valid blog post',
              title: 'Valid Post',
              description: 'A test post',
              estimated_reading_time: 2
            }
          ]
        }
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50
      }
    });

    const command: DbCommand = {
      id: 'test-command-2',
      task: 'test task',
      status: 'running' as CommandStatus,
      user_id: 'test-user',
      created_at: '2023-01-01',
      updated_at: '2023-01-01',
      targets: [
        {
          contents: [
            {
              type: 'blog_post',
              text: 'markdown detailed copy',
              title: 'title of the content',
              description: 'summary of the content',
              estimated_reading_time: 5
            }
          ]
        }
      ]
    };

    const result = await agent.executeCommand(command);
    
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    // Not checking call count since validation may cause multiple calls
    expect(result.updatedCommand).toBeDefined();
    expect(result.updatedCommand?.input_tokens).toBeDefined();
    expect(result.updatedCommand?.output_tokens).toBeDefined();
  });

  test('should handle invalid structure and continue flow with default results', async () => {
    // Mock invalid structure response (mismatched structure)
    (connector.callAgent as jest.Mock).mockResolvedValueOnce({
      content: [
        {
          type: 'contents',
          content: [ // <-- 'content' instead of 'contents'
            {
              type: 'blog_post',
              text: 'This is an invalid structure',
              title: 'Invalid Structure',
              description: 'Test post with wrong structure'
            }
          ]
        }
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50
      }
    });

    const command: DbCommand = {
      id: 'test-command-3',
      task: 'test task',
      status: 'running' as CommandStatus,
      user_id: 'test-user',
      created_at: '2023-01-01',
      updated_at: '2023-01-01',
      targets: [
        {
          contents: [
            {
              type: 'blog_post',
              text: 'markdown detailed copy',
              title: 'title of the content',
              description: 'summary of the content',
              estimated_reading_time: 5
            }
          ]
        }
      ]
    };

    // Set a lower retry count for faster testing
    agent['maxRetries'] = 1;

    const result = await agent.executeCommand(command);
    
    // It should still complete (not fail)
    expect(result.status).toBe('completed');
    
    // Should have a warning indicating structure issues
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('Target processing had structure issues');
    
    // The command should be updated with token counts
    expect(result.updatedCommand).toBeDefined();
    expect(result.updatedCommand?.input_tokens).toBe(100);
    expect(result.updatedCommand?.output_tokens).toBe(50);
    
    // Results should be the default results
    expect(result.results).toBeDefined();
    if (result.results) {
      expect(result.results.length).toBe(1);
      expect(result.results[0].type).toBe('contents');
      expect(result.results[0].content).toBe('Could not process target due to unexpected response format');
    }
  });

  test('should handle exceptions without failing the command', async () => {
    // Mock the connector to throw an error
    (connector.callAgent as jest.Mock).mockRejectedValueOnce(new Error('Test error'));

    const command: DbCommand = {
      id: 'test-command-4',
      task: 'test task',
      status: 'running' as CommandStatus,
      user_id: 'test-user',
      created_at: '2023-01-01',
      updated_at: '2023-01-01',
      targets: [
        {
          contents: [
            {
              type: 'blog_post',
              text: 'markdown detailed copy',
              title: 'title of the content',
              description: 'summary of the content',
              estimated_reading_time: 5
            }
          ]
        }
      ]
    };

    const result = await agent.executeCommand(command);
    
    // Even with an error, it should still complete (not fail)
    expect(result.status).toBe('completed');
    
    // Should have a warning with the error message
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('Error processing targets but proceeding with default values');
    expect(result.warning).toContain('Test error');
    
    // Results should be the default results
    expect(result.results).toBeDefined();
    if (result.results) {
      expect(result.results.length).toBe(1);
      expect(result.results[0].type).toBe('contents');
      expect(result.results[0].content).toBe('Could not process target due to unexpected response format');
    }
  });

  test('should maintain array structure for single-object targets', async () => {
    // Mock the connector to return a valid response with a single object (not wrapped in array)
    (connector.callAgent as jest.Mock).mockResolvedValue({
      content: [
        {
          type: 'contents',
          // Intentionally return a single object instead of an array
          content: {
            type: 'blog_post',
            text: 'This is a single blog post that should be preserved as array',
            title: 'Single Post Test',
            description: 'Testing single object array preservation',
            estimated_reading_time: 1
          }
        }
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50
      }
    });

    const command: DbCommand = {
      id: 'test-command-5',
      task: 'test task',
      status: 'running' as CommandStatus,
      user_id: 'test-user',
      created_at: '2023-01-01',
      updated_at: '2023-01-01',
      targets: [
        {
          contents: [
            {
              type: 'blog_post',
              text: 'markdown detailed copy',
              title: 'title of the content',
              description: 'summary of the content',
              estimated_reading_time: 5
            }
          ]
        }
      ]
    };

    // Expose the internal processing method for direct testing
    const processMethod = agent['processTargetResponse'].bind(agent);
    
    // Get the mock response that would be received
    const mockResponse = await connector.callAgent([], {});
    
    // Process the response directly
    const processedResults = processMethod(mockResponse.content, command.targets || []);
    
    // Verify the structure is preserved
    expect(processedResults).toBeDefined();
    expect(processedResults.length).toBe(1);
    
    // Check if result has the same property structure as target (contents, not content)
    expect(processedResults[0].type).toBe('contents');
    expect(processedResults[0].contents).toBeDefined();
    
    // Critical test: verify content is still an array even though input was a single object
    expect(Array.isArray(processedResults[0].contents)).toBe(true);
    expect(processedResults[0].contents.length).toBeGreaterThan(0);
    expect(processedResults[0].contents[0].type).toBe('blog_post');
    expect(processedResults[0].contents[0].text).toContain('This is a single blog post');
  });

  test('should preserve exact structure of the target object', async () => {
    // Define a complex target structure with nested properties and specific names
    const targetStructure = {
      contents: [
        {
          type: 'blog_post',
          text: 'markdown placeholder',
          title: 'Content Title',
          description: 'Content description',
          estimated_reading_time: 5,
          metadata: {
            category: 'technology',
            tags: ['education', 'tech']
          }
        }
      ]
    };

    // Mock the connector to return a structure that keeps the exact same properties
    (connector.callAgent as jest.Mock).mockResolvedValue({
      content: [
        {
          contents: [
            {
              type: 'blog_post',
              text: 'This is a detailed blog post about technology in education.',
              title: 'Technology in Education',
              description: 'How technology is changing education',
              estimated_reading_time: 7,
              metadata: {
                category: 'technology',
                tags: ['education', 'tech', 'innovation']
              }
            }
          ]
        }
      ],
      usage: {
        input_tokens: 150,
        output_tokens: 180
      }
    });

    const command: DbCommand = {
      id: 'test-command-structure',
      task: 'test structure preservation',
      status: 'running' as CommandStatus,
      user_id: 'test-user',
      created_at: '2023-01-01',
      updated_at: '2023-01-01',
      targets: [targetStructure]
    };

    const result = await agent.executeCommand(command);
    
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(result.results).toBeDefined();
    
    // Make sure we have results and they are the right shape
    if (result.results) {
      expect(result.results.length).toBe(1);
      
      // Extract the processed result for easier testing
      const processedResult = result.results[0];
      
      // Verify the top-level structure is preserved
      expect(Object.keys(processedResult)).toEqual(Object.keys(targetStructure));
      
      // Specifically check the 'contents' property
      expect(processedResult.contents).toBeDefined();
      expect(Array.isArray(processedResult.contents)).toBe(true);
      
      // Check structure of first item in contents array
      const resultItem = processedResult.contents[0];
      const targetItem = targetStructure.contents[0];
      
      // All properties should match exactly - no additions or removals
      expect(Object.keys(resultItem).sort()).toEqual(Object.keys(targetItem).sort());
      
      // Check nested structure of metadata
      expect(resultItem.metadata).toBeDefined();
      expect(typeof resultItem.metadata).toBe('object');
      expect(Object.keys(resultItem.metadata).sort()).toEqual(Object.keys(targetItem.metadata).sort());
    }
  });
}); 