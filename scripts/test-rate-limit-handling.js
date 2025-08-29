/**
 * Test script to verify rate limit error handling in agent processor
 */
import { TargetProcessor } from '../src/lib/agentbase/agents/TargetProcessor.ts';
import { PortkeyConnector } from '../src/lib/agentbase/services/PortkeyConnector.ts';

// Mock the PortkeyConnector to simulate rate limit errors
class MockPortkeyConnector extends PortkeyConnector {
  constructor() {
    super({ apiKey: 'test', virtualKeys: { openai: 'test' } });
  }

  async callAgent(messages, options) {
    // Simulate a 429 rate limit error
    const rateLimitError = {
      status: 429,
      body: {
        error: {
          message: "openai error: Requests to the ChatCompletions_Create Operation under OpenAI Language Model Instance API have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 60 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit. For Free Account customers, upgrade to Pay as you Go here: https://aka.ms/429TrialUpgrade.",
          type: "AI_APICallError",
          param: {
            error: "Requests to the ChatCompletions_Create Operation under OpenAI Language Model Instance API have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 60 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit. For Free Account customers, upgrade to Pay as you Go here: https://aka.ms/429TrialUpgrade.",
            statusCode: 429,
            name: "AI_APICallError",
            message: "Requests to the ChatCompletions_Create Operation under OpenAI Language Model Instance API have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 60 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit. For Free Account customers, upgrade to Pay as you Go here: https://aka.ms/429TrialUpgrade.",
            url: "https://ai-gateway-resource.openai.azure.com/openai/v1/chat/completions?api-version=preview",
            isRetryable: true,
            type: "AI_APICallError"
          },
          code: null
        },
        provider: "openai"
      },
      responseTime: 44363,
      lastUsedOptionJsonPath: "config"
    };

    throw rateLimitError;
  }
}

async function testRateLimitHandling() {
  console.log('🧪 Testing rate limit error handling...');

  try {
    // Create a mock connector that throws rate limit errors
    const mockConnector = new MockPortkeyConnector();
    
    // Create a target processor with the mock connector
    const processor = new TargetProcessor(
      'test-processor',
      'Test Processor',
      mockConnector
    );

    // Create a test command
    const testCommand = {
      id: 'test-command-123',
      task: 'test',
      status: 'pending',
      context: 'Test context',
      targets: [
        {
          type: 'text',
          content: 'Test target content'
        }
      ],
      agent_background: 'You are a test agent.',
      user_id: 'test-user',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    console.log('📝 Executing test command...');
    
    // Execute the command - this should trigger the rate limit error
    const result = await processor.executeCommand(testCommand);
    
    console.log('📊 Result:', JSON.stringify(result, null, 2));
    
    // Verify that the result indicates a rate limit error
    if (result.status === 'failed' && result.error?.includes('Rate limit exceeded')) {
      console.log('✅ Rate limit error handling works correctly!');
      console.log('✅ The command failed gracefully with a proper error message.');
    } else {
      console.log('❌ Rate limit error handling failed!');
      console.log('❌ Expected status: failed with rate limit error message');
      console.log('❌ Actual result:', result);
    }

  } catch (error) {
    console.error('❌ Test failed with unexpected error:', error);
  }
}

// Run the test
testRateLimitHandling().then(() => {
  console.log('🏁 Test completed.');
}).catch((error) => {
  console.error('💥 Test failed:', error);
});
