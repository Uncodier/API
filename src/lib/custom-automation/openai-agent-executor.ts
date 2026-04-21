/**
 * Backwards-compatibility shim.
 *
 * The executor was renamed to {@link AIAgentExecutor} and moved to
 * `./ai-agent-executor`. This file re-exports everything under the legacy
 * name(s) so existing imports keep working:
 *
 *   import { OpenAIAgentExecutor } from '@/lib/custom-automation/openai-agent-executor';
 *
 * New code should import from `./ai-agent-executor` directly.
 */

export {
  AIAgentExecutor,
  AIAgentExecutor as OpenAIAgentExecutor,
} from './ai-agent-executor';

export type {
  ActOptions,
  ActResponse,
  Tool,
  ToolCall,
  ToolResult,
  Step,
  Message,
  AIAgentExecutorConfig,
  AIProvider,
  AzureOpenAIConfig,
} from './ai-agent-executor';
