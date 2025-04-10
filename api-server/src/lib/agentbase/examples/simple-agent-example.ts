/**
 * Simple Agent Example
 * 
 * This example demonstrates the basic usage of the Agentbase library
 * to create and execute a command with a PortkeyAgent.
 */
import {
  CommandFactory,
  CommandService,
  PortkeyAgent,
  PortkeyAgentConnector,
  PortkeyConfig
} from '../index';

async function runSimpleAgentExample() {
  console.log('Starting Simple Agent Example');
  
  // 1. Create configuration for Portkey
  const portkeyConfig: PortkeyConfig = {
    apiKey: process.env.PORTKEY_API_KEY || 'your-portkey-api-key',
    virtualKeys: {
      'anthropic': process.env.ANTHROPIC_API_KEY || 'your-anthropic-api-key',
      'openai': process.env.OPENAI_API_KEY || 'your-openai-api-key',
      'gemini': process.env.GEMINI_API_KEY || 'your-gemini-api-key'
    }
  };
  
  // 2. Create a connector for LLM access
  const connector = new PortkeyAgentConnector(portkeyConfig, {
    modelType: 'anthropic',
    maxTokens: 4096,
    temperature: 0.7
  });
  
  // 3. Create an agent
  const agent = new PortkeyAgent(
    'agent_001',
    'Text Processor',
    connector,
    ['text_processing', 'summarization', 'analysis']
  );
  
  // 4. Create a command service
  const commandService = new CommandService();
  
  // 5. Listen for command events
  commandService.on('commandCreated', (command) => {
    console.log(`Command created: ${command.id}`);
  });
  
  commandService.on('statusChange', (update) => {
    console.log(`Command ${update.id} status changed to: ${update.status}`);
  });
  
  // 6. Create a command
  const command = CommandFactory.createCommand({
    task: 'Summarize the following text in 3 key points: "Agentbase is designed with a key objective: to enable asynchronous calls to multiple language models that can collaboratively work on shared objects while maintaining distinct memories and instructions. The command structure serves as the foundation, allowing multiple agents to iteratively process data, each with its own specialized context and capabilities, yet operating within a unified workflow."',
    userId: 'user_123',
    description: 'Text summarization task',
    agentId: agent.id,
    modelType: 'anthropic',
    responseFormat: 'text',
    tools: [
      CommandFactory.createTool({
        name: 'text_processing',
        description: 'Process text data',
        type: 'synchronous',
        parameters: {
          operation: 'summarize',
          format: 'key_points'
        }
      })
    ]
  });
  
  // 7. Submit the command
  const commandId = await commandService.submitCommand(command);
  console.log(`Submitted command with ID: ${commandId}`);
  
  // 8. Get the command
  const dbCommand = await commandService.getCommandById(commandId);
  
  if (!dbCommand) {
    console.error('Failed to retrieve command');
    return;
  }
  
  // 9. Update command status to running
  await commandService.updateStatus(commandId, 'running');
  
  // 10. Execute the command
  console.log('Executing command...');
  const result = await agent.executeCommand(dbCommand);
  
  // 11. Update command with results
  await commandService.updateCommand(commandId, {
    status: result.status,
    results: result.results
  });
  
  // 12. Display results
  console.log('Command execution complete');
  console.log('Status:', result.status);
  console.log('Results:', JSON.stringify(result.results, null, 2));
  
  // 13. Format the command for display
  const formattedCommand = commandService.formatCommandForDisplay(
    (await commandService.getCommandById(commandId))!
  );
  
  console.log('Formatted Command:', formattedCommand);
}

// Uncomment to run the example
// runSimpleAgentExample().catch(console.error);

export { runSimpleAgentExample }; 