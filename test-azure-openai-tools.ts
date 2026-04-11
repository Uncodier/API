import { OpenAIAgentExecutor } from './src/lib/custom-automation/openai-agent-executor';

async function main() {
  console.log('Testing OpenAIAgentExecutor with 44 tools...');
  const executor = new OpenAIAgentExecutor();
  
  // Create 44 tools
  const tools = Array.from({ length: 44 }).map((_, i) => ({
    name: `tool_${i}`,
    description: `This is tool ${i}`,
    parameters: {
      type: 'object',
      properties: {
        arg: { type: 'string' }
      }
    },
    execute: async () => `Result ${i}`
  }));

  try {
    const response = await executor.act({
      model: 'gpt-5.4', // that maps to deploymentName 'gpt-5.2' but skipping reasoning_effort
      system: 'You are a helpful assistant.',
      prompt: 'Please use tool_43',
      tools: tools,
      stream: true,
      onStreamStart: async () => { console.log('stream start'); return 'log_1'; },
      onStreamChunk: async (id, chunk) => { console.log('chunk:', chunk); },
    });
    
    console.log('Success:', response.text);
  } catch (error) {
    console.error('Error during execution:', error);
  }
}

main().catch(console.error);