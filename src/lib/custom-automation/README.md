# Custom Automation with Azure OpenAI and Scrapybara

This module provides a custom implementation for managing Scrapybara instances using Azure OpenAI's API directly, replacing Scrapybara's built-in `act()` method with your own Azure OpenAI deployment.

## Overview

Instead of using Scrapybara's SDK with their `anthropic()` model wrapper, you can now:
1. Use Azure OpenAI directly with your own deployment
2. Have full control over the agent execution loop
3. Customize tool execution and streaming behavior
4. Interact with Scrapybara instances via direct API calls
5. Benefit from Azure's enterprise features and pricing

## Architecture

The implementation consists of three main components:

### 1. OpenAIAgentExecutor (`openai-agent-executor.ts`)
Replaces Scrapybara's `client.act()` method with a custom implementation using Azure OpenAI's Chat Completions API.

**Features:**
- Full Azure OpenAI function calling support
- Streaming with `onStep` callbacks
- Structured outputs using Zod schemas
- Automatic tool execution loop
- Token usage tracking
- Support for Azure OpenAI deployments

### 2. ScrapybaraTools (`scrapybara-tools.ts`)
Provides tool implementations that interact directly with Scrapybara's API:
- `bash` - Execute bash commands
- `computer` - Control mouse, keyboard, and desktop
- `str_replace_editor` - File operations (read, write, edit)

### 3. ScrapybaraInstanceManager (`scrapybara-instance-manager.ts`)
Direct API client for managing Scrapybara instances:
- Instance lifecycle (start, stop, pause, resume)
- Browser control
- Authentication management
- Environment variables
- Stream URLs

## Usage

### Basic Example

```typescript
import { OpenAIAgentExecutor } from '@/lib/custom-automation/openai-agent-executor';
import { ScrapybaraInstanceManager } from '@/lib/custom-automation/scrapybara-instance-manager';
import { createScrapybaraTools } from '@/lib/custom-automation/scrapybara-tools';
import { z } from 'zod';

// 1. Create instance manager and start instance
const manager = new ScrapybaraInstanceManager(process.env.SCRAPYBARA_API_KEY);
const instance = await manager.startUbuntu({ timeoutHours: 1 });

// 2. Start browser in instance
await manager.startBrowserInInstance(instance.id);

// 3. Create tools for the instance
const tools = createScrapybaraTools(instance);

// 4. Create Azure OpenAI agent executor
const executor = new OpenAIAgentExecutor({
  apiKey: process.env.MICROSOFT_AZURE_OPENAI_API_KEY,
  endpoint: process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT,
  deployment: 'gpt-4o', // Your deployment name
  apiVersion: '2024-08-01-preview',
});

// 5. Define structured output schema (optional)
const schema = z.object({
  event: z.enum(['step_completed', 'step_failed', 'session_needed']),
  step: z.number(),
  assistant_message: z.string(),
});

// 6. Execute agent
const result = await executor.act({
  // model is optional - uses deployment from constructor if not specified
  model: 'gpt-4o', // Or omit to use default deployment
  tools,
  system: 'You are an AI assistant that helps automate web tasks.',
  prompt: 'Go to example.com and extract the page title',
  schema,
  onStep: async (step) => {
    console.log('Step:', step.text);
    if (step.toolCalls) {
      console.log('Tool calls:', step.toolCalls.length);
    }
  },
  maxIterations: 50,
  temperature: 0.7,
});

console.log('Final result:', result.output);
console.log('Token usage:', result.usage);

// 7. Clean up
await manager.stopInstance(instance.id);
```

### Advanced Example with Authentication

```typescript
// Start instance and authenticate
const instance = await manager.startUbuntu({ timeoutHours: 2 });
await manager.startBrowserInInstance(instance.id);

// Apply saved authentication
const authStateId = 'your-saved-auth-state-id';
await manager.authenticateBrowser(instance.id, authStateId);

// Execute with authentication context
const result = await executor.act({
  model: 'gpt-4o',
  tools: createScrapybaraTools(instance),
  system: `You are logged into Facebook. The browser has been authenticated.`,
  prompt: 'Create a new post with the text "Hello World"',
  onStep: async (step) => {
    // Log progress to database
    await supabase.from('logs').insert({
      message: step.text,
      tool_calls: step.toolCalls,
    });
  },
});

// Save new authentication state
const authSession = await manager.saveBrowserAuth(instance.id, 'facebook-session');
console.log('Saved auth:', authSession.authStateId);
```

### Integration with Existing Route

Here's how to replace the Scrapybara SDK in your existing route:

```typescript
// OLD: Using Scrapybara SDK
import { ScrapybaraClient } from 'scrapybara';
import { anthropic } from 'scrapybara/anthropic';
import { bashTool, computerTool, editTool } from 'scrapybara/tools';

const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY });
const instance = await client.get(instanceId);
const result = await client.act({
  model: anthropic(),
  tools: [bashTool(instance), computerTool(instance), editTool(instance)],
  system: SYSTEM_PROMPT,
  prompt: userPrompt,
  schema: responseSchema,
  onStep: handleStep,
});

// NEW: Using Custom Implementation with Azure OpenAI
import { OpenAIAgentExecutor } from '@/lib/custom-automation/openai-agent-executor';
import { ScrapybaraInstanceManager } from '@/lib/custom-automation/scrapybara-instance-manager';
import { createScrapybaraTools } from '@/lib/custom-automation/scrapybara-tools';

const manager = new ScrapybaraInstanceManager(process.env.SCRAPYBARA_API_KEY);
const instance = await manager.getInstance(instanceId);
const executor = new OpenAIAgentExecutor({
  endpoint: process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.MICROSOFT_AZURE_OPENAI_API_KEY,
  deployment: 'gpt-4o', // Your Azure deployment name
});

const result = await executor.act({
  // model is optional if you set deployment in constructor
  tools: createScrapybaraTools(instance),
  system: SYSTEM_PROMPT,
  prompt: userPrompt,
  schema: responseSchema,
  onStep: handleStep,
});
```

## API Reference

### OpenAIAgentExecutor

#### Constructor
```typescript
new OpenAIAgentExecutor(config?: AzureOpenAIConfig | string)

interface AzureOpenAIConfig {
  apiKey?: string;        // Azure OpenAI API key (or use MICROSOFT_AZURE_OPENAI_API_KEY env)
  endpoint?: string;      // Azure OpenAI endpoint (or use MICROSOFT_AZURE_OPENAI_ENDPOINT env)
  deployment?: string;    // Deployment name (or use MICROSOFT_AZURE_OPENAI_DEPLOYMENT env, default: 'gpt-4o')
  apiVersion?: string;    // API version (or use MICROSOFT_AZURE_OPENAI_API_VERSION env, default: '2024-08-01-preview')
}
```

**Example:**
```typescript
// Using config object (recommended)
const executor = new OpenAIAgentExecutor({
  endpoint: 'https://your-resource.openai.azure.com',
  apiKey: 'your-api-key',
  deployment: 'gpt-4o',
});

// Using environment variables (easiest)
const executor = new OpenAIAgentExecutor(); // Reads from env vars
```

#### act(options: ActOptions): Promise<ActResponse>

Execute an agent with tools.

**Options:**
- `model?: string` - Azure deployment name (optional if set in constructor)
- `tools: Tool[]` - Array of tools
- `system?: string` - System prompt
- `prompt?: string` - User prompt (use this OR messages)
- `messages?: Message[]` - Full message history (use this OR prompt)
- `schema?: z.ZodType<any>` - Structured output schema
- `onStep?: (step: Step) => void` - Callback for each step
- `maxIterations?: number` - Max tool loops (default: 50)
- `temperature?: number` - Model temperature (default: 1) - Not supported for o-series models
- `reasoningEffort?: 'low' | 'medium' | 'high'` - Reasoning effort for o-series models (o1, o3, GPT-5.1). Default: 'low'
- `verbosity?: 'low' | 'medium' | 'high'` - Output verbosity for o-series models. Default: 'low'

**Returns:**
```typescript
{
  messages: Message[];     // Full conversation history
  steps: Step[];          // All execution steps
  text: string;           // Final text response
  output?: any;           // Structured output if schema provided
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
```

### ScrapybaraInstanceManager

#### Instance Management
- `startUbuntu(options?)` - Start Ubuntu instance
- `startBrowser(options?)` - Start browser-only instance
- `getInstance(id)` - Get instance by ID
- `stopInstance(id)` - Stop instance
- `pauseInstance(id)` - Pause instance
- `resumeInstance(id, options?)` - Resume paused instance

#### Browser Control
- `startBrowserInInstance(id)` - Start browser
- `stopBrowserInInstance(id)` - Stop browser
- `saveBrowserAuth(id, name)` - Save auth state
- `authenticateBrowser(id, authStateId)` - Apply auth

#### Utilities
- `getStreamUrl(id)` - Get streaming URL
- `setEnvironmentVariables(id, vars)` - Set env vars
- `getEnvironmentVariables(id)` - Get env vars
- `deleteEnvironmentVariables(id, keys)` - Delete env vars

### ScrapybaraTools

#### createScrapybaraTools(instance): Tool[]
Create all tools (bash, computer, edit) for an instance.

#### Individual Tool Creators
- `createBashTool(instance)` - Bash command tool
- `createComputerTool(instance)` - Desktop interaction tool
- `createEditTool(instance)` - File editing tool

## Benefits Over Scrapybara SDK

1. **Cost Control**: Use your own Azure OpenAI deployment with enterprise pricing
2. **Enterprise Features**: Azure's security, compliance, and monitoring
3. **Full Control**: Customize the agent loop, add middleware, logging
4. **Debugging**: Direct access to all API calls and responses
5. **Flexibility**: Use any Azure OpenAI deployment
6. **Custom Tools**: Easy to add your own custom tools
7. **Regional Deployment**: Choose your Azure region for latency/compliance

## Environment Variables

```bash
# Scrapybara
SCRAPYBARA_API_KEY=your_scrapybara_api_key

# Microsoft Azure OpenAI (Direct Robot Execution - separate from Portkey)
MICROSOFT_AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
MICROSOFT_AZURE_OPENAI_API_KEY=your_microsoft_azure_openai_api_key
MICROSOFT_AZURE_OPENAI_DEPLOYMENT=gpt-4o
MICROSOFT_AZURE_OPENAI_API_VERSION=2024-08-01-preview
```

## Notes

- The Scrapybara API endpoints used are based on reverse engineering the SDK
- Some endpoints may change; refer to Scrapybara documentation for updates
- Ensure proper error handling for API calls
- Consider rate limiting and cost monitoring
- Always stop instances when done to avoid charges

## Migration Guide

See the example above for step-by-step migration from Scrapybara SDK to custom implementation.

Key changes:
1. Replace `ScrapybaraClient` with `ScrapybaraInstanceManager`
2. Replace `anthropic()` with `OpenAIAgentExecutor` and OpenAI model
3. Replace SDK tools with `createScrapybaraTools()`
4. Update `client.act()` to `executor.act()` with OpenAI-specific options

