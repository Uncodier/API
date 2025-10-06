# Migration Guide: Scrapybara SDK → Custom OpenAI Implementation

This guide shows exactly how to migrate your existing route from using Scrapybara's SDK to the custom OpenAI implementation.

## Quick Reference

| Scrapybara SDK | Custom Implementation |
|----------------|----------------------|
| `ScrapybaraClient` | `ScrapybaraInstanceManager` |
| `anthropic()` | `OpenAIAgentExecutor` with OpenAI models |
| `bashTool(instance)` | `createBashTool(instance)` |
| `computerTool(instance)` | `createComputerTool(instance)` |
| `editTool(instance)` | `createEditTool(instance)` |
| `client.act()` | `executor.act()` |

## Step-by-Step Migration

### 1. Update Imports

**BEFORE:**
```typescript
import { ScrapybaraClient } from 'scrapybara';
import { bashTool, computerTool, editTool } from 'scrapybara/tools';
import { anthropic } from 'scrapybara/anthropic';
import { UBUNTU_SYSTEM_PROMPT } from 'scrapybara/prompts';
```

**AFTER:**
```typescript
import { 
  OpenAIAgentExecutor,
  ScrapybaraInstanceManager,
  createScrapybaraTools 
} from '@/lib/custom-automation';
// Keep your own system prompt or use a custom one
const UBUNTU_SYSTEM_PROMPT = '...'; // Define your own or import from your prompts
```

### 2. Replace Instance Connection

**BEFORE:**
```typescript
const client = new ScrapybaraClient({ 
  apiKey: process.env.SCRAPYBARA_API_KEY 
});
const remoteInstance = await client.get(instance.provider_instance_id);
```

**AFTER:**
```typescript
const instanceManager = new ScrapybaraInstanceManager(
  process.env.SCRAPYBARA_API_KEY
);
const remoteInstance = await instanceManager.getInstance(
  instance.provider_instance_id
);
```

### 3. Replace Tools Creation

**BEFORE:**
```typescript
const ubuntuInstance = remoteInstance as any;
const tools = [
  bashTool(ubuntuInstance),
  computerTool(ubuntuInstance),
  editTool(ubuntuInstance),
];
```

**AFTER:**
```typescript
const tools = createScrapybaraTools(remoteInstance);
```

### 4. Replace Agent Execution

**BEFORE:**
```typescript
executionResult = await client.act({
  model: anthropic(),
  tools,
  schema: AgentResponseSchema,
  system: systemPromptWithContext,
  prompt: planPrompt,
  onStep: async (step: any) => {
    // Your step handler
  }
});
```

**AFTER:**
```typescript
const executor = new OpenAIAgentExecutor(process.env.OPENAI_API_KEY);

executionResult = await executor.act({
  model: 'gpt-4o', // or 'gpt-4o-mini', 'gpt-4-turbo', etc.
  tools,
  schema: AgentResponseSchema,
  system: systemPromptWithContext,
  prompt: planPrompt,
  temperature: 0.7,
  maxIterations: 50,
  onStep: async (step: any) => {
    // Your step handler - same as before
  }
});
```

### 5. Starting New Instances

**BEFORE:**
```typescript
const client = new ScrapybaraClient({ 
  apiKey: process.env.SCRAPYBARA_API_KEY 
});
const remoteInstance = await client.startUbuntu({ timeoutHours: 1 });
const browserStartResult = await remoteInstance.browser.start();
const cdpUrl = browserStartResult.cdpUrl;
```

**AFTER:**
```typescript
const manager = new ScrapybaraInstanceManager(
  process.env.SCRAPYBARA_API_KEY
);
const remoteInstance = await manager.startUbuntu({ timeoutHours: 1 });
const browserStartResult = await manager.startBrowserInInstance(
  remoteInstance.id
);
const cdpUrl = browserStartResult.cdpUrl;
```

### 6. Authentication Management

**BEFORE:**
```typescript
// Saving auth
const authResult = await remoteInstance.browser.saveAuth({ 
  name: "default" 
});
const authStateId = authResult.authStateId;

// Applying auth
await remoteInstance.browser.authenticate({ authStateId });
```

**AFTER:**
```typescript
// Saving auth
const authSession = await manager.saveBrowserAuth(
  remoteInstance.id, 
  "default"
);
const authStateId = authSession.authStateId;

// Applying auth
await manager.authenticateBrowser(remoteInstance.id, authStateId);
```

### 7. Stopping Instances

**BEFORE:**
```typescript
await remoteInstance.stop();
```

**AFTER:**
```typescript
await manager.stopInstance(remoteInstance.id);
```

## Complete Example: route.ts Migration

Here's a complete before/after comparison for your `/api/robots/plan/act/route.ts`:

### Key Section Changes

```typescript
// ========== IMPORTS SECTION ==========
// BEFORE
import { ScrapybaraClient } from 'scrapybara';
import { bashTool, computerTool, editTool } from 'scrapybara/tools';
import { anthropic } from 'scrapybara/anthropic';

// AFTER
import { 
  OpenAIAgentExecutor,
  ScrapybaraInstanceManager,
  createScrapybaraTools 
} from '@/lib/custom-automation';

// ========== INSTANCE CONNECTION SECTION (around line 1108) ==========
// BEFORE
const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });
const remoteInstance = await client.get(instance.provider_instance_id);

// AFTER
const instanceManager = new ScrapybaraInstanceManager(process.env.SCRAPYBARA_API_KEY);
const remoteInstance = await instanceManager.getInstance(instance.provider_instance_id);

// ========== TOOLS CREATION SECTION (around line 1154) ==========
// BEFORE
const ubuntuInstance = remoteInstance as any;
const tools = [
  bashTool(ubuntuInstance),
  computerTool(ubuntuInstance),
  editTool(ubuntuInstance),
];

// AFTER
const tools = createScrapybaraTools(remoteInstance);

// ========== AGENT EXECUTION SECTION (around line 1268) ==========
// BEFORE
executionResult = await client.act({
  model: anthropic(),
  tools,
  schema: AgentResponseSchema,
  system: systemPromptWithContext,
  prompt: planPrompt,
  onStep: async (step: any) => {
    // ... existing step handler code ...
  }
});

// AFTER
const executor = new OpenAIAgentExecutor(process.env.OPENAI_API_KEY);
executionResult = await executor.act({
  model: 'gpt-4o', // OpenAI model instead of Anthropic
  tools,
  schema: AgentResponseSchema,
  system: systemPromptWithContext,
  prompt: planPrompt,
  temperature: 0.7,
  maxIterations: 50,
  onStep: async (step: any) => {
    // ... existing step handler code - NO CHANGES NEEDED ...
  }
});
```

## Environment Variables

Make sure you have both API keys configured:

```bash
# .env or .env.local
SCRAPYBARA_API_KEY=your_scrapybara_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
```

## Model Options

With the custom implementation, you can use any OpenAI model:

```typescript
// Recommended options:
model: 'gpt-4o'           // Latest, most capable
model: 'gpt-4o-mini'      // Faster, cheaper, still very capable
model: 'gpt-4-turbo'      // Previous generation
model: 'gpt-4'            // Original GPT-4

// Compare to Scrapybara which only offered:
model: anthropic()        // Claude Sonnet (no choice)
```

## Benefits of Migration

1. **Cost Savings**: OpenAI models are generally cheaper than Anthropic via Scrapybara
2. **Model Choice**: Use any OpenAI model (4o, 4o-mini, etc.)
3. **Control**: Full access to the execution loop
4. **Debugging**: See exactly what's happening at each step
5. **Flexibility**: Easy to add custom tools or modify behavior

## Testing After Migration

1. Test with a simple task first:
```typescript
const result = await executor.act({
  model: 'gpt-4o-mini', // Start with cheaper model for testing
  tools: createScrapybaraTools(instance),
  prompt: 'Take a screenshot',
  onStep: (step) => console.log(step),
});
```

2. Verify tool execution works correctly
3. Check structured output parsing
4. Monitor token usage and costs
5. Test error handling

## Rollback Plan

If you need to rollback, simply:
1. Revert the imports
2. Change back to `ScrapybaraClient`
3. Use `anthropic()` model
4. Use SDK's built-in tools

Keep both implementations available during migration for safety.

## Common Issues

### Issue: "Tool not found" error
**Solution**: Make sure you're using `createScrapybaraTools(instance)` and the instance ID is correct.

### Issue: Structured output not working
**Solution**: Verify your Zod schema is correct. OpenAI's structured outputs require strict schemas.

### Issue: High costs
**Solution**: Start with `gpt-4o-mini` for testing, then upgrade to `gpt-4o` for production.

### Issue: Different behavior than Anthropic
**Solution**: Adjust temperature and system prompt. OpenAI models may need different prompting strategies.

## Support

For issues or questions about the custom implementation:
1. Check the README.md in `/src/lib/custom-automation/`
2. Review example-usage.ts for patterns
3. Consult OpenAI documentation for model-specific behavior
4. Check Scrapybara API docs for instance management

## Next Steps

After successful migration:
1. Monitor performance and costs
2. Optimize prompts for OpenAI models
3. Consider adding custom tools
4. Implement better error handling
5. Add logging and monitoring

