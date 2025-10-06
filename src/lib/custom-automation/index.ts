/**
 * Custom Automation Library
 * 
 * OpenAI-based implementation for Scrapybara instance management
 * 
 * @example
 * ```typescript
 * import { OpenAIAgentExecutor, ScrapybaraInstanceManager, createScrapybaraTools } from '@/lib/custom-automation';
 * 
 * const manager = new ScrapybaraInstanceManager();
 * const instance = await manager.startUbuntu();
 * const executor = new OpenAIAgentExecutor();
 * 
 * const result = await executor.act({
 *   model: 'gpt-4o',
 *   tools: createScrapybaraTools(instance),
 *   prompt: 'Your task here',
 * });
 * ```
 */

// Core exports
export { OpenAIAgentExecutor } from './openai-agent-executor';
export { ScrapybaraInstanceManager } from './scrapybara-instance-manager';
export {
  createScrapybaraTools,
  createBashTool,
  createComputerTool,
  createEditTool,
  ScrapybaraInstanceClient,
} from './scrapybara-tools';

// Type exports
export type {
  Tool,
  ToolCall,
  ToolResult,
  Step,
  Message,
  ActOptions,
  ActResponse,
} from './openai-agent-executor';

export type {
  InstanceOptions,
  BrowserStartResult,
  AuthSession,
  Instance,
} from './scrapybara-instance-manager';

export type {
  ScrapybaraInstance,
} from './scrapybara-tools';

