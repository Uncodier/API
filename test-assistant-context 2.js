/**
 * Test script to verify assistant context includes generate_image and generate_video URLs
 */

// Mock data simulating instance_logs with tool results
const mockHistoricalLogs = [
  {
    log_type: 'user_action',
    message: 'Generate an image of a sunset',
    created_at: '2024-01-15T10:00:00Z',
    tool_name: null,
    tool_result: null
  },
  {
    log_type: 'tool_call',
    message: 'generate_image: prompt=Generate a sunset image',
    created_at: '2024-01-15T10:01:00Z',
    tool_name: 'generate_image',
    tool_result: {
      success: true,
      output: {
        images: [
          { url: 'https://storage.example.com/image1.jpg' },
          { url: 'https://storage.example.com/image2.jpg' }
        ]
      }
    }
  },
  {
    log_type: 'user_action',
    message: 'Create a video of ocean waves',
    created_at: '2024-01-15T10:05:00Z',
    tool_name: null,
    tool_result: null
  },
  {
    log_type: 'tool_call',
    message: 'generate_video: prompt=Create ocean waves video',
    created_at: '2024-01-15T10:06:00Z',
    tool_name: 'generate_video',
    tool_result: {
      success: true,
      output: {
        images: [
          { url: 'https://storage.example.com/video1.mp4' }
        ]
      }
    }
  },
  {
    log_type: 'agent_action',
    message: 'I have generated the requested content',
    created_at: '2024-01-15T10:07:00Z',
    tool_name: null,
    tool_result: null
  }
];

// Simulate the context building logic
function buildHistoryContext(historicalLogs) {
  let historyContext = '';
  if (historicalLogs && historicalLogs.length > 0) {
    historyContext = '\n\n📋 CONVERSATION HISTORY:\n';
    historicalLogs.forEach((log, index) => {
      const timestamp = new Date(log.created_at).toLocaleTimeString();
      const role = log.log_type === 'user_action' ? 'User' : 'Assistant';
      
      // Handle tool calls with special formatting for generate_image and generate_video
      if (log.log_type === 'tool_call' && log.tool_name && log.tool_result) {
        if (log.tool_name === 'generate_image' || log.tool_name === 'generate_video') {
          const toolResult = log.tool_result;
          if (toolResult.success && toolResult.output && toolResult.output.images) {
            const urls = toolResult.output.images.map((img) => img.url).filter(Boolean);
            if (urls.length > 0) {
              historyContext += `[${timestamp}] ${role}: Generated ${log.tool_name} - URLs: ${urls.join(', ')}\n`;
            } else {
              historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
            }
          } else {
            historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
          }
        } else {
          historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
        }
      } else {
        historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
      }
    });
  }
  return historyContext;
}

// Test the functionality
console.log('🧪 Testing assistant context with generate_image and generate_video URLs...\n');

const context = buildHistoryContext(mockHistoricalLogs);
console.log('Generated context:');
console.log(context);

// Verify that URLs are included
const hasImageUrls = context.includes('https://storage.example.com/image1.jpg');
const hasVideoUrls = context.includes('https://storage.example.com/video1.mp4');
const hasGeneratedText = context.includes('Generated generate_image') && context.includes('Generated generate_video');

console.log('\n✅ Test Results:');
console.log(`- Image URLs included: ${hasImageUrls ? '✅' : '❌'}`);
console.log(`- Video URLs included: ${hasVideoUrls ? '✅' : '❌'}`);
console.log(`- Generated text present: ${hasGeneratedText ? '✅' : '❌'}`);

if (hasImageUrls && hasVideoUrls && hasGeneratedText) {
  console.log('\n🎉 All tests passed! Assistant context will include URLs for generated images and videos.');
} else {
  console.log('\n❌ Some tests failed. Check the implementation.');
}
