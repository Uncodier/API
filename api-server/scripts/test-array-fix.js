/**
 * Test script for the TargetProcessorAgent fix
 * This script tests if the array structure is correctly preserved when handling single objects
 */

// Import the necessary modules directly with .ts extension
import { TargetProcessorAgent } from '../src/lib/agentbase/agents/TargetProcessorAgent.ts';
import { PortkeyAgentConnector } from '../src/lib/agentbase/services/PortkeyAgentConnector.ts';

// Mock the callAgent method to avoid actual API calls
class MockConnector {
  async callAgent() {
    return {
      content: [
        {
          type: 'contents',
          // Intentionally return a single object that should be wrapped in an array
          content: {
            type: 'blog_post',
            text: 'This is a single blog post that should be preserved as array',
            title: 'Array Structure Test',
            description: 'Testing single object in array preservation',
            estimated_reading_time: 1
          }
        }
      ]
    };
  }
}

// Create a mock connector
const connector = new MockConnector();

// Create test targets similar to real usage
const targets = [
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
];

async function runTest() {
  try {
    console.log('🧪 Testing TargetProcessorAgent array structure preservation...');
    
    // Create an instance of the agent
    const agent = new TargetProcessorAgent('test_id', 'Test Agent', connector);
    
    // Access the private method using reflection (for testing)
    const processMethod = agent['processTargetResponse'].bind(agent);
    
    // Get the mock response
    const mockResponse = await connector.callAgent();
    
    // Process the response
    const processedResults = processMethod(mockResponse.content, targets);
    
    // Verify the structure
    console.log('\n📊 Test Results:');
    console.log('1. Received a response with type:', typeof processedResults[0]);
    
    // Check if content exists
    if (!processedResults[0].contents) {
      console.error('❌ FAILED: Contents property missing in result');
      process.exit(1);
    }
    
    // Critical test - check if we preserved array structure
    const isArray = Array.isArray(processedResults[0].contents);
    console.log(`2. Content is array: ${isArray}`);
    
    if (!isArray) {
      console.error('❌ FAILED: Contents should be an array but is not');
      
      // Show the actual structure
      console.log('\n🔍 Actual result structure:');
      console.log(JSON.stringify(processedResults[0], null, 2));
      
      // Show expected structure
      console.log('\n🎯 Expected structure:');
      console.log(JSON.stringify({
        type: 'contents',
        contents: [{
          type: 'blog_post',
          text: '...',
          title: '...',
          description: '...'
        }]
      }, null, 2));
      
      process.exit(1);
    }
    
    // Check array length
    const arrayLength = processedResults[0].contents.length;
    console.log(`3. Array length: ${arrayLength}`);
    
    if (arrayLength === 0) {
      console.error('❌ FAILED: Contents array is empty');
      process.exit(1);
    }
    
    // Verify content type
    const contentType = processedResults[0].contents[0].type;
    console.log(`4. Content type: ${contentType}`);
    
    if (contentType !== 'blog_post') {
      console.error(`❌ FAILED: Expected content type 'blog_post' but got '${contentType}'`);
      process.exit(1);
    }
    
    // Success!
    console.log('\n✅ SUCCESS: Array structure is correctly preserved!');
    
    // Additional logging of full result
    console.log('\n📝 Full processed result:');
    console.log(JSON.stringify(processedResults, null, 2));
    
  } catch (error) {
    console.error('❌ ERROR during test:', error);
    process.exit(1);
  }
}

// Run the test
runTest(); 