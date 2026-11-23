import type { z } from 'zod';
import type { AssistantExecutionBoundary } from '@/lib/services/robot-instance/assistant-execution-boundary';

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  result: any;
  isError: boolean;
  base64Image?: string | null;
  cleanedResult?: any;
}

export interface Step {
  text: string;
  finishReason?: string;
  provider?: string;
  model?: string;
  generationId?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  output?: any;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost?: number;
    cost_details?: Record<string, unknown>;
    is_byok?: boolean;
  };
}

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
  /** OpenRouter reasoning blocks must be replayed verbatim with tool calls. */
  reasoning_details?: any[];
}

export interface Tool {
  name: string;
  description?: string;
  parameters?: Record<string, any> | z.ZodType<any>;
  execute: (args: any) => Promise<any>;
}

export interface ActOptions {
  /** Host-only callbacks, never deserialized from JSON. */
  executionBoundary?: AssistantExecutionBoundary;
  model?: string;
  siteId?: string;
  tools: Tool[];
  system?: string;
  prompt?: string;
  messages?: Message[];
  schema?: z.ZodType<any>;
  onStep?: (step: Step, meta?: { streamingLogId?: string }) => Promise<void> | void;
  maxIterations?: number;
  /** Explicit output reservation, including reasoning; bounded by the host. */
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  verbosity?: 'low' | 'medium' | 'high';
  stream?: boolean;
  onStreamStart?: () => Promise<string>;
  onStreamChunk?: (
    logId: string,
    accumulatedText: string,
    final?: boolean,
  ) => Promise<void>;
  onThinkingStreamStart?: () => Promise<string>;
  onThinkingStreamChunk?: (
    logId: string,
    accumulatedText: string,
    final?: boolean,
  ) => Promise<void>;
  onReasoningTokensUsed?: (reasoningTokensCount: number) => Promise<void>;
  /** One model turn and at most one actual tool execution attempt; remaining calls receive skipped results. */
  enforceSingleTurn?: boolean;
  /** SDK plan wrappers own their wait semantics and remote retries. */
  preserveToolExecution?: boolean;
  toolOverrides?: Record<string, any>;
  onContextUsage?: (params: { system: string; messages: Message[]; tools: unknown[];
    provider: AIProvider; model: string; providerInputTokens?: number;
    providerOutputTokens?: number | null; responseFormat?: unknown }) => Promise<void>;
  enforceContextBudget?: boolean;
}

export interface ActResponse {
  messages: Message[];
  steps: Step[];
  text: string;
  output?: any;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost?: number;
  };
}

export type AIProvider = 'openrouter' | 'gemini' | 'azure' | 'openai' | 'xai';

export interface AIAgentExecutorConfig {
  /** Legacy model-family hint. Transport is always OpenRouter. */
  provider?: AIProvider;
  /** OpenRouter model id. Defaults to OPENROUTER_CHAT_MODEL. */
  model?: string;
  /** OpenRouter API key. Falls back to OPENROUTER_API_KEY only. */
  apiKey?: string;
  siteId?: string;
  /** @deprecated Ignored: OpenRouter uses a fixed endpoint. */
  baseURL?: string;
  /** Azure-only: resource endpoint, e.g. https://my-resource.openai.azure.com */
  endpoint?: string;
  /** Azure-only: deployment name (becomes part of the baseURL path). */
  deployment?: string;
  /** Azure-only: api-version query string. */
  apiVersion?: string;
}

/**
 * Legacy alias kept for backwards compatibility. New code should prefer
 * `AIAgentExecutorConfig`.
 */
export type AzureOpenAIConfig = AIAgentExecutorConfig;
