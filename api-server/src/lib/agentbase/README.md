# Agentbase Library

A powerful framework for creating and managing multi-agent systems, allowing language models to collaborate asynchronously on complex tasks.

## Overview

Agentbase is designed to enable asynchronous calls to multiple language models that can collaboratively work on shared objects while maintaining distinct memories and instructions. The command structure serves as the foundation, allowing multiple agents to iteratively process data, each with its own specialized context and capabilities, yet operating within a unified workflow.

## Key Components

### Core Components

- **BaseAgent**: Abstract class that all agents extend
- **CommandFactory**: Utility for creating standardized command objects
- **CommandService**: Service for managing command lifecycle
- **MemoryStore**: Store for agent memory management
- **PortkeyAgentConnector**: Connector for LLM providers via the Portkey API

### Agent Types

- **PortkeyAgent**: Basic agent implementation that uses Portkey for LLM communication
- Custom agent implementations can be created by extending BaseAgent or PortkeyAgent

## Basic Usage

### 1. Create a simple agent

```typescript
import { 
  CommandFactory, 
  CommandService, 
  PortkeyAgent, 
  PortkeyAgentConnector 
} from '@/lib/agentbase';

// Configure LLM access
const portkeyConfig = {
  apiKey: process.env.PORTKEY_API_KEY,
  virtualKeys: {
    'anthropic': process.env.ANTHROPIC_API_KEY,
    'openai': process.env.OPENAI_API_KEY,
    'gemini': process.env.GEMINI_API_KEY
  }
};

// Create connector and agent
const connector = new PortkeyAgentConnector(portkeyConfig);
const agent = new PortkeyAgent(
  'agent_001',
  'Text Processor',
  connector,
  ['text_processing', 'summarization']
);

// Create command service
const commandService = new CommandService();

// Create a command
const command = CommandFactory.createCommand({
  task: 'Summarize the following text...',
  userId: 'user_123',
  agentId: agent.id
});

// Submit and execute command
const commandId = await commandService.submitCommand(command);
const dbCommand = await commandService.getCommandById(commandId);

if (dbCommand) {
  await commandService.updateStatus(commandId, 'running');
  const result = await agent.executeCommand(dbCommand);
  console.log(result);
}
```

### 2. Creating a custom agent

Extend BaseAgent or PortkeyAgent to create specialized agents:

```typescript
class ResearchAgent extends PortkeyAgent {
  constructor(id, name, connector) {
    super(id, name, connector, ['research', 'data_fetch']);
  }
  
  // Override executeTool for custom tool implementation
  async executeTool(tool) {
    switch (tool.name) {
      case 'search':
        return this.performSearch(tool.parameters);
      default:
        return super.executeTool(tool);
    }
  }
  
  private async performSearch(params) {
    // Custom search implementation
    return { results: [...] };
  }
}
```

### 3. Multi-agent workflow

```typescript
// Create specialized agents
const researchAgent = new ResearchAgent('agent_research', 'Research Agent', connector);
const analysisAgent = new AnalysisAgent('agent_analysis', 'Analysis Agent', connector);
const supervisorAgent = new SupervisorAgent('agent_supervisor', 'Supervisor Agent', connector);

// Research command
const researchCommand = CommandFactory.createCommand({
  task: 'Research topic X',
  userId: 'user_123',
  agentId: researchAgent.id,
  tools: [...]
});

const researchCommandId = await commandService.submitCommand(researchCommand);
const researchResult = await executeAgent(researchCommandId, researchAgent);

// Analysis command with research results
const analysisCommand = CommandFactory.createCommand({
  task: 'Analyze research findings',
  userId: 'user_123',
  agentId: analysisAgent.id,
  context: JSON.stringify(researchResult.results),
  tools: [...]
});

const analysisCommandId = await commandService.submitCommand(analysisCommand);
const analysisResult = await executeAgent(analysisCommandId, analysisAgent);

// Supervision if needed
if (analysisResult.status === 'pending_supervision') {
  const supervisionCommand = CommandFactory.createCommand({
    task: 'Review analysis results',
    userId: 'user_123',
    agentId: supervisorAgent.id,
    context: JSON.stringify(analysisResult),
    tools: [...]
  });
  
  const supervisionCommandId = await commandService.submitCommand(supervisionCommand);
  const supervisionResult = await executeAgent(supervisionCommandId, supervisorAgent);
}

// Helper function to execute agent
async function executeAgent(commandId, agent) {
  const dbCommand = await commandService.getCommandById(commandId);
  if (!dbCommand) throw new Error('Command not found');
  
  await commandService.updateStatus(commandId, 'running');
  const result = await agent.executeCommand(dbCommand);
  
  await commandService.updateCommand(commandId, {
    status: result.status,
    results: result.results
  });
  
  return result;
}
```

## Examples

See the `examples` directory for more detailed usage examples:
- `simple-agent-example.ts`: Basic usage with a single agent
- `multi-agent-workflow.ts`: Complex workflow with multiple specialized agents

## Features

- **Command-based Architecture**: Standardized command structure for consistent agent interactions
- **Tool Execution**: Agents can execute various tools to accomplish tasks
- **Memory Management**: Persistent memory store for agents
- **Supervision**: Optional supervision and approval workflows
- **Error Handling**: Retry mechanisms and circuit breakers for robustness
- **Event System**: Event-based architecture for command lifecycle hooks

## Future Enhancements

- Database integration for persistent storage
- Streaming responses for real-time updates
- More specialized agent types
- Advanced tool implementations
- Web-based supervision interface 