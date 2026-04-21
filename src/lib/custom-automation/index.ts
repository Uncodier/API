/**
 * Custom Automation Library
 *
 * Provider-agnostic agent executor + optional Scrapybara integration.
 *
 * @example Gemini (default)
 * ```ts
 * import { AIAgentExecutor } from '@/lib/custom-automation';
 *
 * const executor = new AIAgentExecutor(); // reads AI_PROVIDER/AI_MODEL/GEMINI_API_KEY
 * const result = await executor.act({
 *   tools: myTools,
 *   prompt: 'Your task here',
 * });
 * ```
 *
 * @example Azure OpenAI
 * ```ts
 * const executor = new AIAgentExecutor({ provider: 'azure' });
 * ```
 */

export {
  AIAgentExecutor,
  // Legacy alias - prefer AIAgentExecutor in new code.
  OpenAIAgentExecutor,
} from './ai-agent-executor';

export { ScrapybaraInstanceManager } from './scrapybara-instance-manager';
export {
  createScrapybaraTools,
  createBashTool,
  createComputerTool,
  createEditTool,
  ScrapybaraInstanceClient,
} from './scrapybara-tools';

export type {
  Tool,
  ToolCall,
  ToolResult,
  Step,
  Message,
  ActOptions,
  ActResponse,
  AIAgentExecutorConfig,
  AIProvider,
  // Legacy alias
  AzureOpenAIConfig,
} from './ai-agent-executor';

export type {
  InstanceOptions,
  BrowserStartResult,
  AuthSession,
  Instance,
} from './scrapybara-instance-manager';

export type {
  ScrapybaraInstance,
} from './scrapybara-tools';
