/**
 * Test script to verify image generation error handling
 * This tests that errors are properly thrown instead of returned as successful output
 */

import { generateImageTool } from './src/app/api/agents/tools/generateImage/assistantProtocol.js';

async function testErrorHandling() {
  console.log('🧪 Testing image generation error handling...');
  
  const tool = generateImageTool('test-site-id');
  
  try {
    // Test with invalid parameters to trigger an error
    const result = await tool.execute({
      prompt: '', // Empty prompt should trigger validation error
    });
    
    console.log('❌ ERROR: Tool should have thrown an error but returned:', result);
    console.log('This means the error handling is NOT working correctly');
    return false;
    
  } catch (error) {
    console.log('✅ SUCCESS: Tool correctly threw an error:', error.message);
    console.log('This means the error handling is working correctly');
    return true;
  }
}

// Run the test
testErrorHandling()
  .then(success => {
    if (success) {
      console.log('🎉 All tests passed! Error handling is working correctly.');
      process.exit(0);
    } else {
      console.log('💥 Tests failed! Error handling needs to be fixed.');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('💥 Test execution failed:', error);
    process.exit(1);
  });
