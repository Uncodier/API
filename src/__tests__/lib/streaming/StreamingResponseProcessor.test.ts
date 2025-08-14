/**
 * Test for StreamingResponseProcessor timeout fixes
 */
import { StreamingResponseProcessor } from '../../../lib/agentbase/agents/streaming/StreamingResponseProcessor';
import { DbCommand } from '../../../lib/agentbase/models/types';

// Mock command for testing
const mockCommand: DbCommand = {
  id: 'test-command-1',
  site_id: 'test-site',
  context: 'Test context',
  targets: [
    {
      type: 'test_target',
      data: 'test data'
    }
  ],
  status: 'pending',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

// Mock fill function
const fillTargetWithContent = (target: any, content: any) => ({
  ...target,
  result: content
});

describe('StreamingResponseProcessor Timeout Fixes', () => {
  describe('processStreamingResponse', () => {
    test('should handle chunk timeout gracefully', async () => {
      // Create a mock stream that will timeout
      const createTimeoutStream = () => {
        let chunkCount = 0;
        return {
          [Symbol.asyncIterator]: async function* () {
            yield {
              choices: [{
                delta: {
                  content: 'Starting content...'
                }
              }]
            };
            
            // Simulate a long delay that would trigger timeout
            await new Promise(resolve => setTimeout(resolve, 150000)); // 2.5 minutes - longer than 2min chunk timeout
            
            yield {
              choices: [{
                delta: {
                  content: 'More content that should timeout'
                }
              }]
            };
          }
        };
      };

      const timeoutStream = createTimeoutStream();
      
      const start = Date.now();
      const result = await StreamingResponseProcessor.processStreamingResponse(
        timeoutStream,
        mockCommand,
        { modelType: 'openai', modelId: 'gpt-4' },
        fillTargetWithContent
      );
      const duration = Date.now() - start;

      // Should timeout much faster than the 2.5 minute delay
      expect(duration).toBeLessThan(130000); // Should timeout within ~2 minutes
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Chunk timeout');
    }, 180000); // 3 minute test timeout

    test('should process normal stream without timeout', async () => {
      // Create a mock stream that behaves normally
      const createNormalStream = () => {
        return {
          [Symbol.asyncIterator]: async function* () {
            const chunks = [
              'This is ',
              'a normal ',
              'streaming ',
              'response ',
              'that works ',
              'correctly.'
            ];
            
            for (const chunk of chunks) {
              // Small delay between chunks to simulate real streaming
              await new Promise(resolve => setTimeout(resolve, 100));
              yield {
                choices: [{
                  delta: {
                    content: chunk
                  }
                }]
              };
            }
            
            // Final chunk with usage info
            yield {
              usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30
              }
            };
          }
        };
      };

      const normalStream = createNormalStream();
      
      const result = await StreamingResponseProcessor.processStreamingResponse(
        normalStream,
        mockCommand,
        { modelType: 'openai', modelId: 'gpt-4' },
        fillTargetWithContent
      );

      expect(result.status).toBe('completed');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].result).toBe('This is a normal streaming response that works correctly.');
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(20);
    });

    test('should recover partial content when possible', async () => {
      // Create a stream that produces some content then times out
      const createPartialStream = () => {
        return {
          [Symbol.asyncIterator]: async function* () {
            // Yield some content
            yield {
              choices: [{
                delta: {
                  content: 'This is partial content '
                }
              }]
            };
            
            yield {
              choices: [{
                delta: {
                  content: 'that should be recovered.'
                }
              }]
            };
            
            // Now timeout
            await new Promise(resolve => setTimeout(resolve, 130000)); // > 2 minutes
            
            yield {
              choices: [{
                delta: {
                  content: 'This should not be reached'
                }
              }]
            };
          }
        };
      };

      const partialStream = createPartialStream();
      
      const result = await StreamingResponseProcessor.processStreamingResponse(
        partialStream,
        mockCommand,
        { modelType: 'openai', modelId: 'gpt-4' },
        fillTargetWithContent
      );

      // Should recover with partial content
      expect(result.status).toBe('completed'); // Should be marked as completed due to recovery
      expect(result.warning).toContain('Partial content recovered');
      expect(result.results).toHaveLength(1);
      expect(result.results[0]._metadata.partial).toBe(true);
      expect(result.results[0].result).toContain('This is partial content that should be recovered.');
    }, 180000); // 3 minute test timeout
  });

  describe('processStreamContent', () => {
    test('should process JSON content correctly', () => {
      const jsonContent = JSON.stringify([
        { id: 1, name: 'Test 1' },
        { id: 2, name: 'Test 2' }
      ]);

      const results = StreamingResponseProcessor.processStreamContent(
        jsonContent,
        mockCommand,
        fillTargetWithContent
      );

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe(1);
      expect(results[1].id).toBe(2);
    });

    test('should handle non-JSON content', () => {
      const textContent = 'This is just plain text content';

      const results = StreamingResponseProcessor.processStreamContent(
        textContent,
        mockCommand,
        fillTargetWithContent
      );

      expect(results).toHaveLength(1);
      expect(results[0].result).toBe(textContent);
    });
  });
});
