/**
 * AI Agent Executor
 *
 * OpenRouter-only agent executor using Chat Completions with tool calling.
 * Legacy provider labels are model-family hints, never alternate transports.
 * The default model is configured through OPENROUTER_CHAT_MODEL.
 *
 * CRITICAL: OpenAI/Azure Image Handling Pattern
 * =============================================
 * OpenAI/Azure does NOT allow images in 'tool' role messages.
 * Images can ONLY appear in 'user' role messages.
 *
 * Solution implemented:
 * 1. Extract base64 images from tool results
 * 2. Add 'tool' message with text result (no image)
 * 3. Immediately add 'user' message with the image
 *
 * This replicates how Scrapybara's backend handles OpenAI models and also
 * works for Gemini through the OpenAI compatibility layer.
 *
 * @see https://ai.google.dev/gemini-api/docs/openai
 * @see https://learn.microsoft.com/azure/ai-services/openai/
 * @see https://platform.openai.com/docs/guides/vision
 */

import type OpenAI from 'openai';
import { createOpenRouterClient, isOpenRouterReasoningModel, resolveOpenRouterModel } from '@/lib/services/ai/openrouter';
import { fitInstanceRequest, resolveModelContextCapacity } from '@/lib/services/robot-instance/instance-context-budget';
import { getVisionImageSourceUrl } from '@/lib/services/robot-instance/vision-message-images';
import { normalizeToolOperationResult } from '@/lib/services/tool-operation-result';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ensureAzureSafeDataImageUrl,
  isAzureInvalidImageError,
  sanitizeMessagesForAzureVisionImages,
} from './azure-vision-message-sanitize';
import { sanitizeMessagesForGemini } from './gemini-message-sanitize';
import { coerceToolArgs } from './coerce-tool-args';

/**
 * Detects whether a string looks like a raw base64 encoded raster image (PNG, JPEG, GIF, WEBP)
 * by checking the leading magic bytes in base64 form. Purely length-based heuristics cause
 * large file contents from tools like `sandbox_read_file` to be misclassified as screenshots,
 * corrupting the conversation (`[Image captured...]` placeholder) and producing Azure vision
 * errors (`invalid_image_format` / `dropped from history`).
 */
function isLikelyBase64ImagePayload(value: string): boolean {
  if (!value || value.length < 64) return false;
  const head = value.slice(0, 24);
  if (!/^[A-Za-z0-9+/=_-]+$/.test(head)) return false;
  return (
    head.startsWith('/9j/') ||        // JPEG (FFD8FF)
    head.startsWith('iVBORw0KGgo') || // PNG  (89 50 4E 47 0D 0A 1A 0A)
    head.startsWith('R0lGOD') ||      // GIF87a / GIF89a
    head.startsWith('UklGR')          // RIFF / WEBP
  );
}

/** Only the generated linked-reference envelope, never arbitrary URL mentions. */
function linkedImageSources(content: any[]): Set<string> {
  const text = content[0]?.type === 'text' ? content[0].text : undefined;
  if (typeof text !== 'string') return new Set();
  const match = text.match(/^\[Reference Context from linked node ([^\]\r\n]+)\]:\nNode reference: (\{[^\r\n]*\})\n/);
  if (!match) return new Set();
  try {
    const reference = JSON.parse(match[2]);
    if (typeof reference.node_id !== 'string' || !reference.node_id || reference.reference_type !== match[1]) return new Set();
    // The generated URL list is appended after untrusted linked-node prose.
    const listStart = text.lastIndexOf('\n\nCRITICAL - Image URLs for reference (');
    const list = listStart >= 0
      ? text.slice(listStart).match(/^\n\nCRITICAL - Image URLs for reference \([^\r\n]*\):\n([\s\S]*)$/)?.[1] : undefined;
    return new Set(list?.split('\n') || []);
  } catch {
    return new Set();
  }
}

function imageReferencePriority(content: any[], index: number, source: string, linked: Set<string>): number {
  // Node execution must use linked assets, not unrelated conversation history.
  if (linked.has(source)) return 3;
  const label = content[index - 1];
  const match = label?.type === 'text' && typeof label.text === 'string'
    ? label.text.match(/^Image reference: (\{[^\r\n]*\})\nSource URL: ([^\r\n]+)$/) : undefined;
  if (!match || match[2] !== source) return 0;
  try {
    const reference = JSON.parse(match[1]);
    return reference.reply_target === true ? 2 : reference.current_attachment === true ? 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * Bound vision parts without letting new tool screenshots evict explicit targets.
 * Rank linked-node, reply, then current references before other images; break ties
 * by latest occurrence. Select exact sources once, but never reorder identity or
 * chronology text. All selection state is local, with no extra provider fields.
 */
function filterImages(messages: any[], imagesToKeep: number): void {
  type Candidate = { messageIndex: number; partIndex: number; source: string; priority: number };
  const candidates: Candidate[] = [];
  const invalid = new Map<any, string>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    const linked = linkedImageSources(msg.content);
    for (let partIndex = 0; partIndex < msg.content.length; partIndex++) {
      const part = msg.content[partIndex];
      if (part?.type !== 'image_url') continue;
      const raw = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      const source = getVisionImageSourceUrl(part);
      if (typeof raw !== 'string' || !/^(data:image\/|https?:\/\/)/.test(raw) || !source) {
        invalid.set(part, 'Image unavailable: invalid image source. This image is NOT visible. Do not substitute another image or infer its contents.');
        continue;
      }
      candidates.push({ messageIndex, partIndex, source,
        priority: imageReferencePriority(msg.content, partIndex, source, linked) });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority || b.messageIndex - a.messageIndex || b.partIndex - a.partIndex);
  const selected = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (selected.size >= imagesToKeep) break;
    if (!selected.has(candidate.source)) selected.set(candidate.source, candidate);
  }
  for (const candidate of candidates) {
    if (selected.get(candidate.source) === candidate) continue;
    const { messageIndex, partIndex, source } = candidate;
    // Never turn large inline bytes into text or a provider-specific metadata field.
    const identity = /^https?:\/\//.test(source) ? JSON.stringify(source)
      : `inline image at message ${messageIndex + 1}, part ${partIndex + 1}`;
    const reason = selected.has(source)
      ? 'Duplicate image occurrence omitted; exact-source duplicates share one vision slot'
      : `Image omitted from vision due to the ${imagesToKeep}-image limit`;
    messages[messageIndex].content[partIndex] = { type: 'text', text: `${reason}: ${identity}. This occurrence is NOT visible; identity text alone is not image access. Do not describe or infer its contents unless this exact source is attached elsewhere in this request. If a requested image is not attached, explain the limit and ask for fewer images; do not substitute another image.` };
  }

  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      msg.content = msg.content.map((part: any) => invalid.has(part) ? { type: 'text', text: invalid.get(part) } : part);
    }

    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg.content.includes('base64') || msg.content.length > 50000) {
        console.log(`🧹 [IMAGE_FILTER] Cleaning base64 data from tool message`);
        msg.content = msg.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REMOVED]');
      }

      if (msg.content.includes('generateImage') || msg.content.includes('image_urls') || msg.content.includes('provider')) {
        console.log(`🧹 [IMAGE_FILTER] Cleaning generateImage tool message content`);
        msg.content = msg.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REMOVED]');
      }
    }
  }
}

// Types
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
  model?: string;
  siteId?: string;
  tools: Tool[];
  system?: string;
  prompt?: string;
  messages?: Message[];
  schema?: z.ZodType<any>;
  onStep?: (step: Step, meta?: { streamingLogId?: string }) => Promise<void> | void;
  maxIterations?: number;
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


/**
 * Log routing and status only. SDK error bodies, headers and prompt excerpts
 * can echo credentials and must not be included in application logs.
 */
function logChatCompletionFailure(
  err: unknown,
  ctx: {
    provider: AIProvider | string;
    stage: 'stream' | 'fallback' | 'non-stream';
    baseURL?: string;
    modelName?: string;
    messages?: unknown[];
    toolCount?: number;
    tools?: unknown[];
  },
): void {
  const error = err as { status?: unknown; request_id?: unknown } | undefined;
  // Never log SDK error bodies/headers or prompt previews: gateways can echo
  // credentials, tool arguments or private context in their rejection details.
  console.error('[AI EXECUTOR] OpenRouter request failed', {
    provider: ctx.provider,
    stage: ctx.stage,
    model: ctx.modelName,
    messageCount: ctx.messages?.length,
    toolCount: ctx.toolCount,
    status: typeof error?.status === 'number' ? error.status : undefined,
  });
}


/**
 * Extract the first balanced JSON value (object or array) from a string.
 * Handles the Gemini failure mode where two tool-call argument payloads get
 * concatenated into the same string (e.g. `{"a":1}{"b":2}`), returning the
 * first one so we can at least execute one tool instead of throwing.
 */
function extractFirstJsonValue(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trimStart();
  if (!trimmed) return null;
  const open = trimmed[0];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return trimmed.slice(0, i + 1);
    }
  }
  return null;
}

/**
 * Lenient parse for the `arguments` field of a streamed tool_call.
 *
 * Strict JSON.parse first; if that fails, try to recover the first balanced
 * JSON value (covers the `{...}{...}` concat case from Gemini's streaming).
 *
 * Always returns a sanitized JSON string so the caller can mutate the
 * assistant message in history and avoid 400s on the next provider call.
 */
function safeParseToolArgs(raw: string | undefined | null): {
  ok: boolean;
  value: any;
  sanitized: string;
  error?: string;
} {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, value: {}, sanitized: '{}' };
  }
  const text = String(raw);
  try {
    const value = JSON.parse(text);
    return { ok: true, value, sanitized: text };
  } catch (err) {
    const repaired = extractFirstJsonValue(text);
    if (repaired) {
      try {
        const value = JSON.parse(repaired);
        return { ok: true, value, sanitized: repaired };
      } catch {
        /* fall through */
      }
    }
    return {
      ok: false,
      value: {},
      sanitized: '{}',
      error: (err as Error).message,
    };
  }
}

export class AIAgentExecutor {
  private client: OpenAI;
  private model: string;
  private provider: AIProvider;
  private readonly siteId?: string;
  private contextModelId: string | null = null;

  constructor(config?: AIAgentExecutorConfig | string) {
    // Back-compat: string arg is treated as an API key for the selected provider.
    if (typeof config === 'string') {
      config = { apiKey: config };
    }

    if (config?.apiKey !== undefined && config.provider && config.provider !== 'openrouter') {
      throw new Error('Legacy provider credentials are not accepted by OpenRouter. Use provider: openrouter with an OpenRouter API key.');
    }
    if (config?.endpoint || config?.deployment || config?.apiVersion ||
        (config?.provider === 'azure' && config.model && !config.model.includes('/') && !/^(gpt-|o\d)/.test(config.model))) {
      throw new Error('Azure deployment configuration cannot be migrated automatically. Select an OpenRouter catalog model ID.');
    }

    this.provider = 'openrouter';
    this.siteId = config?.siteId;
    this.client = createOpenRouterClient({ apiKey: config?.apiKey });
    this.model = resolveOpenRouterModel(config?.model, config?.provider);

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [AI EXECUTOR] provider=${this.provider} model=${this.model}`);
  }

  /** Expose the resolved provider (useful for callers that log/route). */
  getProvider(): AIProvider {
    return this.provider;
  }

  /** Expose the resolved default model. */
  getModel(): string {
    return this.model;
  }

  /**
   * Extract and strip base64 images from tool results
   * Images will be sent separately as user messages (OpenAI requirement)
   */
  private extractBase64Image(result: any): { cleanedResult: any; base64Image: string | null } {
    let base64Image: string | null = null;

    if (typeof result === 'object' && result !== null && result.provider && result.image_urls) {
      console.log(`🧹 [IMAGE_FILTER] Processing generateImage tool result`);
      return {
        cleanedResult: result,
        base64Image: null
      };
    }

    if (typeof result === 'string') {
      if (result.startsWith('data:image') || isLikelyBase64ImagePayload(result)) {
        const imageData = result.startsWith('data:image') ? result : `data:image/png;base64,${result}`;
        return {
          cleanedResult: 'Screenshot captured successfully.',
          base64Image: imageData
        };
      }
      return { cleanedResult: result, base64Image: null };
    }

    if (typeof result === 'object' && result !== null) {
      const cleaned: any = Array.isArray(result) ? [] : {};

      for (const [key, value] of Object.entries(result)) {
        if (key === 'base64_image' || key === 'base64Image' || key === 'screenshot' || key === 'image') {
          if (
            typeof value === 'string' &&
            (value.startsWith('data:image') || isLikelyBase64ImagePayload(value))
          ) {
            base64Image = value.startsWith('data:image') ? value : `data:image/png;base64,${value}`;
            cleaned[key] = '[Image captured - will be shown separately]';
          } else {
            cleaned[key] = value;
          }
        } else if (
          typeof value === 'string' &&
          (value.startsWith('data:image') || isLikelyBase64ImagePayload(value))
        ) {
          base64Image = value.startsWith('data:image') ? value : `data:image/png;base64,${value}`;
          cleaned[key] = '[Image captured - will be shown separately]';
        } else if (typeof value === 'object' && value !== null) {
          const nested = this.extractBase64Image(value);
          cleaned[key] = nested.cleanedResult;
          if (nested.base64Image && !base64Image) {
            base64Image = nested.base64Image;
          }
        } else {
          cleaned[key] = value;
        }
      }

      return { cleanedResult: cleaned, base64Image };
    }

    return { cleanedResult: result, base64Image: null };
  }

  /**
   * Run streaming completion: iterate over chunks, accumulate message, call onStreamChunk.
   * Supports reasoning/thinking via delta.reasoning_content or delta.reasoning (o-series, etc).
   * Throttles DB updates to ~80ms to avoid excessive instance_log writes.
   */
  private async runStreamingCompletion(
    completionOptions: Record<string, any>,
    callbacks: {
      onStreamStart: () => Promise<string>;
      onStreamChunk: (
        logId: string,
        text: string,
        final?: boolean,
      ) => Promise<void>;
      onThinkingStreamStart?: () => Promise<string>;
      onThinkingStreamChunk?: (
        logId: string,
        text: string,
        final?: boolean,
      ) => Promise<void>;
      onReasoningTokensUsed?: (count: number) => Promise<void>;
    },
  ): Promise<{
    message: any;
    generationId?: string;
    model?: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    finish_reason?: string;
    streamingLogId?: string;
  }> {
    const opts = {
      ...completionOptions,
      stream: true,
      stream_options: { include_usage: true },
    };
    const stream = await this.client.chat.completions.create(opts as any).catch(err => {
      console.error(`[AI STREAM INIT ERROR][${this.provider}] Provider stream unavailable`);
      if (err.status) console.error(`   Status: ${err.status}`);
      throw err;
    });

    let content = '';
    let generationId: string | undefined;
    let responseModel: string | undefined;
    let reasoningContent = '';
    const reasoningDetails: any[] = [];
    // `extra_content` carries Gemini 3's thought_signature
    // (`extra_content.google.thought_signature`). We MUST persist it verbatim
    // across the history or the next call 400s with "Function call is missing
    // a thought_signature". See:
    //   https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures
    //   https://github.com/openai/openai-openapi/issues/517
    const toolCallsAccum: Record<string | number, { id?: string; type: 'function'; function: { name?: string; arguments?: string }; extra_content?: any; insertedAt: number }> = {};
    let insertionCounter = 0;
    let finishReason: string | undefined;
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    let streamingLogId: string | undefined;
    let thinkingLogId: string | undefined;
    const STREAM_THROTTLE_MS = 80;
    let lastEmitTime = 0;
    let lastThinkingEmitTime = 0;

    for await (const chunk of stream as unknown as AsyncIterable<any>) {
      if (chunk.id) generationId = chunk.id;
      if (chunk.model) responseModel = chunk.model;
      if (chunk.usage) {
        usage = chunk.usage;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta || {};

      // OpenRouter reasoning blocks carry encrypted state required for tool replay.
      // Merge streamed fragments by their index; never expose these as tool arguments.
      for (const detail of delta.reasoning_details || []) {
        const previous = detail.index !== undefined
          ? reasoningDetails.find(value => value.index === detail.index && value.type === detail.type)
          : undefined;
        if (!previous) reasoningDetails.push({ ...detail });
        else {
          const fragments = Object.fromEntries(['text', 'data', 'summary', 'signature']
            .filter(key => typeof detail[key] === 'string')
            .map(key => [key, (previous[key] || '') + detail[key]]));
          Object.assign(previous, detail, fragments);
        }
      }

      const reasoningDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
      if (reasoningDelta && callbacks.onThinkingStreamStart && callbacks.onThinkingStreamChunk) {
        reasoningContent += reasoningDelta;
        if (!thinkingLogId) {
          thinkingLogId = await callbacks.onThinkingStreamStart();
        }
        const now = Date.now();
        if (now - lastThinkingEmitTime >= STREAM_THROTTLE_MS && thinkingLogId) {
          lastThinkingEmitTime = now;
          await callbacks.onThinkingStreamChunk(thinkingLogId, reasoningContent);
        }
      }

      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        if (!streamingLogId) {
          streamingLogId = await callbacks.onStreamStart();
        }
        const now = Date.now();
        if (now - lastEmitTime >= STREAM_THROTTLE_MS && streamingLogId) {
          lastEmitTime = now;
          await callbacks.onStreamChunk(streamingLogId, content);
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          // Gemini's OpenAI-compat layer often omits `index` on tool_call deltas.
          // Falling back to `?? 0` collapses unrelated tool calls into the same
          // slot and concatenates their `arguments` strings (e.g. `{...}{...}`),
          // which then explodes in JSON.parse downstream.
          // Use `tc.id` to disambiguate when available; only fall back to 0
          // when there is truly nothing else.
          let idx: number | string;
          if (typeof tc.index === 'number') {
            idx = tc.index;
          } else if (tc.id) {
            idx = `id:${tc.id}`;
          } else {
            // Reuse last seen slot if we have one with a name but no closing
            // (continuation chunk); otherwise start a new one.
            const keys = Object.keys(toolCallsAccum);
            idx = keys.length > 0 ? keys[keys.length - 1] : 0;
          }
          if (!toolCallsAccum[idx]) {
            toolCallsAccum[idx] = { type: 'function', function: {}, insertedAt: insertionCounter++ };
          }
          if (tc.id) toolCallsAccum[idx].id = tc.id;
          if (tc.function?.name) toolCallsAccum[idx].function!.name = tc.function.name;
          if (tc.function?.arguments) {
            toolCallsAccum[idx].function!.arguments = (toolCallsAccum[idx].function!.arguments || '') + (tc.function.arguments || '');
          }
          // Gemini 3: preserve vendor extras (thought_signature). Later
          // deltas may replace/extend the object — keep the most recent
          // complete value.
          if (tc.extra_content && typeof tc.extra_content === 'object') {
            toolCallsAccum[idx].extra_content = {
              ...(toolCallsAccum[idx].extra_content || {}),
              ...tc.extra_content,
            };
          }
        }
      }
    }

    if (streamingLogId && content) {
      await callbacks.onStreamChunk(streamingLogId, content, true);
    }
    if (thinkingLogId && reasoningContent && callbacks.onThinkingStreamChunk) {
      await callbacks.onThinkingStreamChunk(thinkingLogId, reasoningContent, true);
    }

    if (!thinkingLogId && callbacks.onReasoningTokensUsed && usage) {
      const u = usage as any;
      const reasoningTokens =
        u?.completion_tokens_details?.reasoning_tokens ??
        u?.output_tokens_details?.reasoning_tokens ??
        u?.reasoning_tokens ??
        0;
      if (reasoningTokens > 0) {
        await callbacks.onReasoningTokensUsed(reasoningTokens);
      }
    }

    const toolCallsArray = Object.values(toolCallsAccum)
      .sort((a, b) => a.insertedAt - b.insertedAt)
      .filter((tc) => tc.id && tc.function?.name);

    const message: any = {
      role: 'assistant',
      content: content || null,
      ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
    };
    if (toolCallsArray.length > 0) {
      message.tool_calls = toolCallsArray.map((tc) => {
        const out: any = {
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function!.name!, arguments: tc.function!.arguments || '{}' },
        };
        if (tc.extra_content) out.extra_content = tc.extra_content;
        return out;
      });
    }

    return { message, usage, generationId, model: responseModel, finish_reason: finishReason, streamingLogId };
  }

  /**
   * Main execution method that mimics Scrapybara's act() functionality
   */
  async act(options: ActOptions): Promise<ActResponse> {
    const {
      model,
      tools,
      system,
      prompt,
      messages: initialMessages,
      schema,
      onStep,
      maxIterations = 50,
      temperature = 1,
      reasoningEffort = 'low',
      verbosity = 'low',
      stream: useStreaming = false,
      onStreamStart,
      onStreamChunk,
      onThinkingStreamStart,
      onThinkingStreamChunk,
      onReasoningTokensUsed,
      enforceSingleTurn = false,
      preserveToolExecution = false,
      toolOverrides,
      onContextUsage,
      enforceContextBudget = false,
    } = options;

    const modelName = model ? resolveOpenRouterModel(model) : this.model;
    const provider = this.provider;
    const isReasoningModel = isOpenRouterReasoningModel(modelName);

    const uniqueTools: any[] = [];
    const seenToolNames = new Set<string>();
    for (const tool of tools) {
      if (!seenToolNames.has(tool.name)) {
        uniqueTools.push(tool);
        seenToolNames.add(tool.name);
      }
    }
    const finalTools = uniqueTools;

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Initializing with ${finalTools.length} tool(s):`);
    finalTools.forEach((tool, index) => {
      console.log(`  ${index + 1}. ${tool.name} - ${tool.description || 'No description'}`);
      if (tool.parameters) {
        const isZodSchema = typeof tool.parameters === 'object' && '_def' in tool.parameters;
        console.log(`     Parameters: ${isZodSchema ? 'Zod Schema' : 'JSON Schema'}`);
      }
    });

    const messages: Message[] = [];

    if (system) {
      messages.push({ role: 'system', content: system });
    }

    if (initialMessages) {
      // When `system` is explicit, drop any system messages already present
      // in `initialMessages`. This is the typical re-entry case: the caller
      // passes back our previous return value (which always begins with the
      // system message we prepended). Without this filter, every additional
      // turn adds another system entry, producing histories like
      // [system_new, system_old, user, assistant, tool]. Gemini's
      // OpenAI-compat layer 400s (no body) on multi-system histories, and
      // Azure/OpenAI just waste tokens on the duplicate prompt.
      const sanitizedInitial = system
        ? initialMessages.filter((m: any) => m?.role !== 'system')
        : initialMessages;
      const droppedSystems = initialMessages.length - sanitizedInitial.length;
      if (droppedSystems > 0) {
        console.log(
          `₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Dropped ${droppedSystems} duplicate system message(s) from initialMessages (using explicit system param)`,
        );
      }
      messages.push(...sanitizedInitial);
    } else if (prompt) {
      messages.push({ role: 'user', content: prompt });
    }

    const openaiTools = finalTools.map(tool => {
      let parameters: Record<string, any>;

      if (tool.parameters && typeof tool.parameters === 'object' && '_def' in tool.parameters) {
        parameters = zodToJsonSchema(tool.parameters as z.ZodType<any>, {
          target: 'openApi3',
          $refStrategy: 'none',
        }) as Record<string, any>;
      } else {
        parameters = tool.parameters as Record<string, any> || { type: 'object', properties: { _dummy: { type: 'string', description: 'Not used' } } };
      }

      // 🚨 CRITICAL FIX FOR GEMINI 🚨
      // Gemini API strictly rejects tool schemas where type is 'object' but properties is empty {}.
      // If we find an empty properties object, we MUST inject a dummy property.
      if (parameters && parameters.type === 'object') {
        if (!parameters.properties || Object.keys(parameters.properties).length === 0) {
          parameters.properties = { _dummy: { type: 'string', description: 'Not used' } };
        }
      }

      return {
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          parameters,
        },
      };
    });

    const steps: Step[] = [];
    let totalUsage: ActResponse['usage'] = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let allCompletionCostsKnown = true;
    let iterations = 0;
    let finalText = '';
    let finalOutput: any = undefined;

    let lastScreenshotHash: string | null = null;
    let consecutiveIdenticalScreenshots = 0;

    const MAX_SCREENSHOT_HISTORY = 5;
    const screenshotHistory: string[] = [];

    const MAX_ITERATIONS_WITHOUT_OUTPUT = 30;
    let iterationsWithoutOutput = 0;

    while (iterations < maxIterations) {
      iterations++;

      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Iteration ${iterations}/${maxIterations}`);

      if (schema && iterationsWithoutOutput > MAX_ITERATIONS_WITHOUT_OUTPUT) {
        console.error(`⚠️ [EXECUTOR] Safety limit reached: ${iterationsWithoutOutput} iterations without structured output. Stopping.`);
        break;
      }

      try {
        const iterationStartTime = Date.now();
        console.log(`\n⏱️ ========== ITERATION ${iterations} TIMING BREAKDOWN ==========`);

        const imagesBefore = messages.filter((m: any) =>
          m.role === 'user' && Array.isArray(m.content) &&
          m.content.some((c: any) => c.type === 'image_url')
        ).length;

        filterImages(messages, MAX_SCREENSHOT_HISTORY);

        const imagesAfter = messages.filter((m: any) =>
          m.role === 'user' && Array.isArray(m.content) &&
          m.content.some((c: any) => c.type === 'image_url')
        ).length;

        if (imagesBefore > imagesAfter) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [IMAGE_FILTER] Reduced image-bearing messages by ${imagesBefore - imagesAfter}; explicit references take priority over recency`);
        }

        // Gemini's OpenAI-compat layer 400s (no body) when assistant turns
        // carry `content: null` together with `tool_calls`, or when tool
        // messages still include the deprecated `name` field. Normalize both
        // before every call so retries and the streaming/non-streaming
        // fallback paths share a clean history.
        if (provider === 'gemini') {
          const {
            assistantContentCoerced,
            toolContentCoerced,
            toolNameStripped,
            assistantExtrasStripped,
            toolCallExtrasStripped,
            imagePartsStripped,
            systemMessagesDeduped,
            thoughtSignatureSentinelsInjected,
          } = sanitizeMessagesForGemini(messages);
          if (
            assistantContentCoerced > 0 ||
            toolContentCoerced > 0 ||
            toolNameStripped > 0 ||
            assistantExtrasStripped > 0 ||
            toolCallExtrasStripped > 0 ||
            imagePartsStripped > 0 ||
            systemMessagesDeduped > 0 ||
            thoughtSignatureSentinelsInjected > 0
          ) {
            console.warn(
              `₍ᐢ•(ܫ)•ᐢ₎ [GEMINI_SANITIZE] coerced ${assistantContentCoerced} assistant content(s) + ${toolContentCoerced} tool content(s) to "", stripped ${toolNameStripped} tool name field(s), ${assistantExtrasStripped} assistant extra field(s), ${toolCallExtrasStripped} tool_call extra field(s), ${imagePartsStripped} malformed image part(s), deduped ${systemMessagesDeduped} extra system message(s), injected ${thoughtSignatureSentinelsInjected} thought_signature sentinel(s)`,
            );
          }
        }

        // Azure vision sanitization only applies to Azure. Other providers (Gemini, OpenAI)
        // accept the same data URLs that Azure rejects.
        if (provider === 'azure') {
          const visionStripped = sanitizeMessagesForAzureVisionImages(messages);
          if (visionStripped > 0) {
            console.warn(
              `₍ᐢ•(ܫ)•ᐢ₎ [AZURE_VISION] Removed ${visionStripped} unsupported or invalid image part(s) before API call`
            );
          }
        }

        const completionOptions: any = {
          model: modelName,
          messages,
          ...((options.siteId || this.siteId) ? { user: options.siteId || this.siteId } : {}),
        };

        // After enough iterations with a schema, drop tools to force JSON output.
        const shouldForceJson = schema && iterations > 15;

        if (!shouldForceJson && openaiTools.length > 0) {
          completionOptions.tools = openaiTools;
          // The selected GPT-6 model does not advertise parallel_tool_calls.
          // Local single-turn execution remains authoritative for all models.
          if (enforceSingleTurn && !isReasoningModel) {
            completionOptions.parallel_tool_calls = false;
          }
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Including tools in API call`);
        } else if (shouldForceJson) {
          console.log(`⚠️ [EXECUTOR] Forcing JSON output - removing tools (iteration ${iterations})`);
        }

        // Temperature: Azure reasoning models reject non-default values; Gemini accepts it.
        if (!isReasoningModel && temperature !== 1) {
          completionOptions.temperature = temperature;
        }

        // OpenRouter normalizes reasoning controls for namespaced models.
        if (isReasoningModel) {
          completionOptions.reasoning = { effort: reasoningEffort };
          completionOptions.verbosity = verbosity;
        }

        if (schema) {
          const jsonSchema = this.zodToJsonSchema(schema);
          completionOptions.response_format = {
            type: 'json_schema',
            json_schema: {
              name: 'response',
              schema: jsonSchema,
              strict: true,
            },
          };
        }

        const capacityModel = this.contextModelId || modelName;
        if (enforceContextBudget) {
          await resolveModelContextCapacity(provider, capacityModel);
          fitInstanceRequest({ provider, model: capacityModel, messages, tools: completionOptions.tools || [],
            responseFormat: completionOptions.response_format });
        }
        if (onContextUsage) {
          try {
            await onContextUsage({ system: system || '', messages, tools: completionOptions.tools || [],
              provider, model: capacityModel, responseFormat: completionOptions.response_format });
          } catch (error) {
            console.warn('[AI EXECUTOR] Context usage checkpoint unavailable:', error);
          }
        }

        const useStreamingPath = useStreaming && onStreamStart && onStreamChunk && !schema;
        const useThinkingStream = useStreamingPath && onThinkingStreamStart && onThinkingStreamChunk;

        const optsForLog = { ...completionOptions, stream: useStreamingPath, stream_options: undefined, messages: `[${messages.length} messages omitted]` };
        console.log(`🔍 [DEBUG][${provider}] API Payload Options:`, JSON.stringify(optsForLog, null, 2));

        let response: { message: any; usage?: any; finish_reason?: string; generationId?: string; model?: string };

        if (useStreamingPath) {
          try {
            const streamCallbacks: Parameters<typeof this.runStreamingCompletion>[1] = {
              onStreamStart: onStreamStart!,
              onStreamChunk: onStreamChunk!,
              onReasoningTokensUsed: onReasoningTokensUsed,
            };
            if (useThinkingStream) {
              streamCallbacks.onThinkingStreamStart = onThinkingStreamStart!;
              streamCallbacks.onThinkingStreamChunk = onThinkingStreamChunk!;
            }
            response = await this.runStreamingCompletion(
              completionOptions,
              streamCallbacks
            );
          } catch (streamError: any) {
            logChatCompletionFailure(streamError, {
              provider,
              stage: 'stream',
              baseURL: (this.client as any)?.baseURL,
              modelName,
              messages,
              toolCount: openaiTools.length,
              tools: openaiTools,
            });

            // A broken stream/callback can follow an accepted, billed generation.
            // Never create another generation to hide that ambiguous outcome.
            throw streamError;
          }
        } else {
          console.log(`⏱️ [TIMING] Calling ${provider.toUpperCase()} API...`);
          const apiStartTime = Date.now();
          let completion;
          try {
            completion = await this.client.chat.completions.create(completionOptions);
          } catch (apiErr: any) {
            if (provider === 'azure' && isAzureInvalidImageError(apiErr)) {
              sanitizeMessagesForAzureVisionImages(messages);
              completion = await this.client.chat.completions.create(completionOptions);
            } else {
              logChatCompletionFailure(apiErr, {
                provider,
                stage: 'non-stream',
                baseURL: (this.client as any)?.baseURL,
                modelName,
                messages,
                toolCount: openaiTools.length,
                tools: openaiTools,
              });
              throw apiErr;
            }
          }
          const apiEndTime = Date.now();
          const apiDuration = apiEndTime - apiStartTime;
          console.log(`⏱️ [TIMING][${provider}] Response received in ${apiDuration}ms (${(apiDuration/1000).toFixed(1)}s)`);

          const choice = completion.choices[0];
          response = {
            message: choice.message,
            usage: completion.usage,
            generationId: completion.id,
            model: completion.model,
            finish_reason: choice.finish_reason ?? undefined,
          } as any;
        }

        const message = response.message;

        if (response.usage) {
          if (onContextUsage && response.usage.prompt_tokens > 0) {
            try {
              await onContextUsage({ system: system || '', messages, tools: completionOptions.tools || [],
                provider, model: capacityModel, providerInputTokens: response.usage.prompt_tokens,
                providerOutputTokens: response.usage.completion_tokens,
                responseFormat: completionOptions.response_format });
            } catch (error) {
              console.warn('[AI EXECUTOR] Provider usage checkpoint unavailable:', error);
            }
          }
          totalUsage.promptTokens += response.usage.prompt_tokens || 0;
          totalUsage.completionTokens += response.usage.completion_tokens || 0;
          totalUsage.totalTokens += response.usage.total_tokens || 0;
        }
        // A partial sum must never be presented as the actual cost of the whole run.
        if (typeof response.usage?.cost !== 'number' || !Number.isFinite(response.usage.cost)) {
          allCompletionCostsKnown = false;
          delete totalUsage.cost;
        } else if (allCompletionCostsKnown) {
          totalUsage.cost = (totalUsage.cost ?? 0) + response.usage.cost;
        }

        messages.push(message as Message);

        const step: Step = {
          text: message.content || '',
          provider,
          model: response.model || modelName,
          ...(response.generationId ? { generationId: response.generationId } : {}),
          usage: {
            promptTokens: response.usage?.prompt_tokens || 0,
            completionTokens: response.usage?.completion_tokens || 0,
            totalTokens: response.usage?.total_tokens || 0,
            ...(response.usage?.cost !== undefined ? { cost: response.usage.cost } : {}),
            ...(response.usage?.cost_details !== undefined ? { cost_details: response.usage.cost_details } : {}),
            ...(response.usage?.is_byok !== undefined ? { is_byok: response.usage.is_byok } : {}),
          },
        };

        finalText = message.content || '';

        if (schema && message.content) {
          try {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCHEMA] Attempting to parse structured output...`);
            const parsed = JSON.parse(message.content);
            const validated = schema.parse(parsed);
            step.output = validated;
            finalOutput = validated;
            iterationsWithoutOutput = 0;
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCHEMA] ✅ Structured output validated:`, validated);
          } catch (error) {
            iterationsWithoutOutput++;
            console.log(`⚠️ [SCHEMA] Iterations without output: ${iterationsWithoutOutput}/${MAX_ITERATIONS_WITHOUT_OUTPUT}`);
            console.error('❌ [SCHEMA] Failed to parse structured output:', error);
            console.error('❌ [SCHEMA] Message content:', message.content?.substring(0, 200));
          }
        } else {
          if (schema && !message.content) {
            iterationsWithoutOutput++;
            console.log(`⚠️ [SCHEMA] Schema provided but no message content received (${iterationsWithoutOutput}/${MAX_ITERATIONS_WITHOUT_OUTPUT})`);
          } else if (schema) {
            iterationsWithoutOutput++;
          }
        }

        if (message.tool_calls && message.tool_calls.length > 0) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] Received ${message.tool_calls.length} tool_call(s) from ${provider}`);

          // Parse each tool call with a lenient parser. Track which ones could
          // not be recovered so we can answer them with an error tool message
          // (and keep history valid for the next provider call).
          const toolCalls: ToolCall[] = [];
          const unparseable: Array<{ id: string; name: string; error: string }> = [];

          for (const tc of message.tool_calls) {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_PARSE] Parsing tool call: ${tc.id} - ${tc.function.name}`);
            const parsed = safeParseToolArgs(tc.function.arguments);

            // CRITICAL: Mutate the assistant message in-place so the value
            // stored in `messages` is always valid JSON. Otherwise providers
            // like Gemini reject the next chat.completions.create with a 400
            // (no body) because the prior assistant.tool_calls.arguments is
            // not parseable JSON.
            if (tc.function.arguments !== parsed.sanitized) {
              tc.function.arguments = parsed.sanitized;
            }

            if (parsed.ok) {
              const toolDef = finalTools.find(t => t.name === tc.function.name);
              let finalArgs = parsed.value;
              if (toolDef && toolDef.parameters) {
                finalArgs = coerceToolArgs(toolDef.parameters, finalArgs);
                
                // Re-serialize back to arguments to keep history consistent with coerced state
                const stringified = JSON.stringify(finalArgs);
                if (tc.function.arguments !== stringified) {
                  tc.function.arguments = stringified;
                }
              }

              toolCalls.push({
                toolCallId: tc.id,
                toolName: tc.function.name,
                args: finalArgs,
              });
            } else {
              console.error(
                `₍ᐢ•(ܫ)•ᐢ₎ [TOOL_PARSE] ❌ Unrecoverable arguments for ${tc.function.name} (${tc.id}): ${parsed.error}`
              );
              unparseable.push({
                id: tc.id,
                name: tc.function.name,
                error: parsed.error || 'invalid JSON',
              });
            }
          }

          if (unparseable.length > 0) {
            // Reply to the unparseable calls with an error tool message so the
            // model can self-correct on the next iteration. The assistant
            // message already has its arguments sanitized to "{}" above.
            for (const bad of unparseable) {
              const toolToExecute = finalTools.find(t => t.name === bad.name);
              const helpMessage = toolToExecute?.description ? `\n\nTool Help / Instructions:\n${toolToExecute.description}` : '';

              messages.push({
                role: 'tool',
                tool_call_id: bad.id,
                name: bad.name,
                content: `Error parsing tool call arguments: ${bad.error}. The arguments string was not valid JSON. Re-issue the tool call with a single, well-formed JSON object.${helpMessage}`,
              });
            }

            // If NONE of the tool calls were parseable, skip executor work and
            // let the next iteration retry. Otherwise, proceed to execute the
            // ones that did parse — the unparseable ones already have their
            // tool message above.
            if (toolCalls.length === 0 && !enforceSingleTurn) {
              console.warn(
                `₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] All ${unparseable.length} tool call(s) had invalid arguments; continuing to next iteration after sanitizing history.`
              );
              continue;
            }
          }

          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ✅ Successfully parsed ${toolCalls.length} tool call(s)${unparseable.length > 0 ? ` (${unparseable.length} unparseable, answered with error)` : ''}`);

          step.toolCalls = toolCalls;

          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] Executing ${toolCalls.length} tool call(s):`);
          toolCalls.forEach((tc, idx) => {
            console.log(`  ${idx + 1}. ${tc.toolName} (${tc.toolCallId}) - Args:`, JSON.stringify(tc.args).substring(0, 100));
          });

          const toolResults: ToolResult[] = [];
          const allToolsStartTime = Date.now();

          // Collect images first, then attach them as a single user message AFTER all tool messages.
          const collectedImages: string[] = [];
          let toolExecutionStarted = false;

          for (const toolCall of toolCalls) {
            const toolStartTime = Date.now();
            console.log(`⏱️ [TOOL_START] ${toolCall.toolName} (${toolCall.toolCallId}) - Starting execution...`);
            const tool = finalTools.find(t => t.name === toolCall.toolName);

            if (!tool) {
              const errorMsg = `Error: Tool ${toolCall.toolName} not found`;
              console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_ERROR] Tool not found: ${toolCall.toolName} (${toolCall.toolCallId})`);

              toolResults.push({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result: errorMsg,
                isError: true,
              });

              messages.push({
                role: 'tool',
                tool_call_id: toolCall.toolCallId,
                name: toolCall.toolName,
                content: errorMsg,
              });

              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_MSG] ✅ Added tool message for ${toolCall.toolCallId}`);

              continue;
            }

            if (enforceSingleTurn && toolExecutionStarted) {
              // Do not delete the provider's calls or leave dangling IDs: every
              // call needs a result before history can be reused on the next turn.
              const skippedResult = {
                success: false,
                status: 'skipped',
                executed: false,
                error: 'single_turn_tool_limit',
                message: 'Not executed: this turn allows only one tool execution attempt. Request this call again in a later turn if still needed.',
              };
              toolResults.push({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result: skippedResult,
                isError: true,
              });
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.toolCallId,
                name: toolCall.toolName,
                content: JSON.stringify(skippedResult),
              });
              continue;
            }

            // A failed attempt may already have effects. It consumes the budget
            // just like a successful invocation (including locally handled wait).
            toolExecutionStarted = true;
            try {
              let result: any;

              // Execute wait actions locally instead of round-trip to Scrapybara.
              if (!preserveToolExecution && toolCall.toolName === 'computer' && toolCall.args.action === 'wait') {
                const duration = toolCall.args.duration || 1000;
                console.log(`⚡ [WAIT_LOCAL] Executing wait locally for ${duration}ms instead of calling Scrapybara`);

                await new Promise(resolve => setTimeout(resolve, duration));

                result = `Waited for ${duration}ms`;
                console.log(`⚡ [WAIT_LOCAL] Local wait completed`);
              } else {
                const isScrapybaraTool = ['computer', 'bash', 'edit'].includes(toolCall.toolName);

                if (isScrapybaraTool) {
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] Calling ${toolCall.toolName}.execute() with Scrapybara SDK...`);
                } else {
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [LOCAL] Executing ${toolCall.toolName}.execute() locally...`);
                }
                
                // --- FORCE OVERRIDES FOR TOOLS ROUTER ---
                if (toolCall.toolName === 'tools' && toolCall.args.action === 'call') {
                  const targetToolName = toolCall.args.name;
                  if (targetToolName && toolOverrides?.[targetToolName]) {
                    try {
                      const innerArgs = typeof toolCall.args.args === 'string' ? JSON.parse(toolCall.args.args) : (toolCall.args.args || {});
                      const mergedArgs = { ...innerArgs, ...toolOverrides[targetToolName] };
                      toolCall.args.args = JSON.stringify(mergedArgs);
                      console.log(`[AI EXECUTOR] Force-injected overrides for ${targetToolName}`, toolOverrides[targetToolName]);
                    } catch (e) {
                      console.warn(`[AI EXECUTOR] Could not inject overrides for ${targetToolName}`, e);
                    }
                  }
                }

                let executeAttempts = 0;
                const maxExecuteAttempts = enforceSingleTurn || preserveToolExecution ? 1 : 2;
                while (executeAttempts < maxExecuteAttempts) {
                  try {
                    result = await tool.execute(toolCall.args);
                    break;
                  } catch (e: any) {
                    if (e?.name === 'RecoveryError') throw e;
                    executeAttempts++;
                    const msg = e.message || '';
                    const isTransient = msg.includes('410') || msg.includes('422') || msg.includes('sandbox_stopping') || msg.includes('timeout') || msg.includes('socket');
                    if (isTransient && executeAttempts < maxExecuteAttempts) {
                      console.warn(`⚠️ [TOOL_RETRY] ${toolCall.toolName} transient error: ${msg}. Retrying (${executeAttempts}/${maxExecuteAttempts})...`);
                      await new Promise(res => setTimeout(res, 2000 * executeAttempts));
                    } else {
                      throw e;
                    }
                  }
                }

                if (result === undefined || result === null) {
                  const logPrefix = isScrapybaraTool ? '[SCRAPYBARA]' : '[LOCAL]';
                  console.warn(`⚠️ ${logPrefix} ${toolCall.toolName} returned ${result === undefined ? 'undefined' : 'null'}`);
                } else if (typeof result === 'object') {
                  const keys = Object.keys(result);
                  const logPrefix = isScrapybaraTool ? '[SCRAPYBARA]' : '[LOCAL]';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${logPrefix} Result is object with keys: [${keys.join(', ')}]`);

                  if (isScrapybaraTool) {
                    if (result.error && result.error.length > 0) {
                      console.error(`⚠️ [SCRAPYBARA] Error field contains: "${result.error}"`);
                    }

                    if (result.output && result.output.length > 0) {
                      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] Output: "${result.output.substring(0, 200)}"`);
                    }

                    if (result.failed || result.success === false) {
                      console.error(`⚠️ [SCRAPYBARA] Result indicates failure:`, result.failed || 'success=false');
                    }

                    if (toolCall.args.action !== 'take_screenshot' &&
                        (!result.output || result.output === '') &&
                        (!result.error || result.error === '')) {
                      console.warn(`⚠️ [SCRAPYBARA] ${toolCall.args.action} returned empty output and error - action may not have executed`);
                      console.warn(`⚠️ [SCRAPYBARA] This usually indicates the browser window lost focus or X11 display has input issues`);
                      console.warn(`⚠️ [SCRAPYBARA] Full result keys:`, Object.keys(result).join(', '));
                    }

                    if (result.system) {
                      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] System info:`, JSON.stringify(result.system));

                      if (typeof result.system === 'object') {
                        if (result.system.error || result.system.message || result.system.status) {
                          console.error(`🚨 [SCRAPYBARA_SYSTEM] System field indicates issue:`, result.system);
                        }
                      }
                    }
                  }
                } else {
                  const logPrefix = isScrapybaraTool ? '[SCRAPYBARA]' : '[LOCAL]';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${logPrefix} Result type: ${typeof result}, length: ${String(result).length}`);
                }
              }

              const toolEndTime = Date.now();
              const toolDuration = toolEndTime - toolStartTime;
              console.log(`⏱️ [TOOL_END] ${toolCall.toolName} completed in ${toolDuration}ms (${(toolDuration/1000).toFixed(1)}s)`);

              const { cleanedResult, base64Image: extractedImage } = this.extractBase64Image(result);
              // Azure-specific data URL coercion; skip for other providers since it
              // can drop otherwise-valid PNG/JPEG payloads.
              let base64Image: string | null;
              if (provider === 'azure') {
                base64Image = extractedImage ? ensureAzureSafeDataImageUrl(extractedImage) : null;
                if (extractedImage && !base64Image) {
                  console.warn(
                    `₍ᐢ•(ܫ)•ᐢ₎ [TOOL_IMAGE] ${toolCall.toolName} returned image bytes not usable for Azure vision (dropped from history)`
                  );
                }
              } else {
                base64Image = extractedImage;
              }

              if (base64Image) {
                console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_IMAGE] ${toolCall.toolName} returned base64 image (${base64Image.length} chars)`);

                const screenshotHash = base64Image.substring(0, 100);
                if (lastScreenshotHash === screenshotHash) {
                  consecutiveIdenticalScreenshots++;
                  console.warn(`⚠️ [SCREENSHOT_DUPLICATE] Screenshot #${consecutiveIdenticalScreenshots + 1} is identical to previous one - browser may not be responding to actions`);

                  if (consecutiveIdenticalScreenshots >= 3) {
                    console.error(`🚨 [SCREENSHOT_DUPLICATE] ${consecutiveIdenticalScreenshots + 1} consecutive identical screenshots detected!`);
                    console.error(`🚨 [SCREENSHOT_DUPLICATE] Browser is likely NOT responding to computer tool actions`);
                    console.error(`🚨 [SCREENSHOT_DUPLICATE] Recent actions: ${toolCalls.map(tc => `${tc.toolName}(${tc.args.action})`).join(', ')}`);
                  }
                } else {
                  if (consecutiveIdenticalScreenshots > 0) {
                    console.log(`✅ [SCREENSHOT_CHANGED] Screenshot changed after ${consecutiveIdenticalScreenshots + 1} identical ones`);
                  }
                  consecutiveIdenticalScreenshots = 0;
                  lastScreenshotHash = screenshotHash;
                }

                collectedImages.push(base64Image);

                screenshotHistory.push(base64Image);
                if (screenshotHistory.length > MAX_SCREENSHOT_HISTORY) {
                  screenshotHistory.shift();
                }
              } else {
                console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_NO_IMAGE] ${toolCall.toolName} - no image in result`);
              }

              const operation = normalizeToolOperationResult(cleanedResult ?? result);
              toolResults.push({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result,
                base64Image: base64Image,
                cleanedResult: cleanedResult,
                isError: operation.outcome === 'failed',
              });

              messages.push({
                role: 'tool',
                tool_call_id: toolCall.toolCallId,
                name: toolCall.toolName,
                content: typeof cleanedResult === 'string' ? cleanedResult : JSON.stringify(cleanedResult),
              });

              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_MSG] ✅ Added tool message for ${toolCall.toolCallId}`);

            } catch (error: any) {
              // A lost owner or unpersisted observation is not proof the tool failed.
              // Stop the turn without retrying or inventing a failed tool reply.
              if (error?.name === 'RecoveryError') throw error;
              const toolEndTime = Date.now();
              const toolDuration = toolEndTime - toolStartTime;
              const errorMessage = error.message || String(error);
              console.error(`⏱️ [TOOL_ERROR] ${toolCall.toolName} (${toolCall.toolCallId}) failed after ${toolDuration}ms (${(toolDuration/1000).toFixed(1)}s) - ${errorMessage.substring(0, 100)}`);

              const toolToExecute = finalTools.find(t => t.name === toolCall.toolName);
              const helpMessage = toolToExecute?.description ? `\n\nTool Help / Instructions:\n${toolToExecute.description}` : '';

              // Estandarizar errores de tool (ZodError o similares)
              let structuredError: any = {
                success: false,
                error: errorMessage,
              };

              if (error.errors || error.issues) {
                const issues = error.errors || error.issues;
                structuredError.code = 'VALIDATION_ERROR';
                structuredError.details = issues;
                structuredError.hint = `Verifica los tipos de datos enviados. Los arrays no deben ir como strings anidados. Parámetros de la tool:\n${JSON.stringify(toolToExecute?.parameters || {}, null, 2)}`;
              }

              const errorContent = JSON.stringify(structuredError, null, 2) + helpMessage;

              toolResults.push({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result: errorContent,
                isError: true,
              });

              messages.push({
                role: 'tool',
                tool_call_id: toolCall.toolCallId,
                name: toolCall.toolName,
                content: errorContent,
              });

              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_MSG] ✅ Added error tool message for ${toolCall.toolCallId}`);
            }
          }

          const allToolsEndTime = Date.now();
          const allToolsDuration = allToolsEndTime - allToolsStartTime;
          console.log(`⏱️ [TOOLS_TOTAL] All ${toolCalls.length} tool(s) executed in ${allToolsDuration}ms (${(allToolsDuration/1000).toFixed(1)}s)`);

          // Safety: guarantee every tool_call has a matching tool message.
          const toolMessageIds = new Set(
            messages
              .filter((m: any) => m.role === 'tool')
              .map((m: any) => m.tool_call_id)
          );

          const missingToolCallIds = toolCalls.filter(tc => !toolMessageIds.has(tc.toolCallId));

          if (missingToolCallIds.length > 0) {
            console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ❌ CRITICAL: ${missingToolCallIds.length} tool_call_id(s) missing tool messages!`);
            missingToolCallIds.forEach(tc => {
              console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ❌ Missing: ${tc.toolCallId} (${tc.toolName})`);

              messages.push({
                role: 'tool',
                tool_call_id: tc.toolCallId,
                name: tc.toolName,
                content: `Error: Tool execution failed unexpectedly. No response recorded.`,
              });
            });
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ✅ Added emergency tool messages for missing tool_call_ids`);
          } else {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ✅ All ${toolCalls.length} tool_call_ids have corresponding tool messages`);
          }

          const shouldIncludeScreenshots = iterations <= 3 || iterations % 3 === 0;

          const screenshotsToSend = screenshotHistory.length > 0 ? screenshotHistory : collectedImages;

          if (screenshotsToSend.length > 0 && shouldIncludeScreenshots) {
            const isHistorical = screenshotsToSend === screenshotHistory;
            const historyNote = isHistorical ? ` (including ${screenshotHistory.length} from history for context)` : '';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCREENSHOTS] Adding ${screenshotsToSend.length} screenshot(s)${historyNote} as single user message in iteration ${iterations}`);

            const imageContent: any[] = [
              {
                type: 'text',
                text: screenshotsToSend.length === 1
                  ? 'Here is the visual result from the previous action:'
                  : `Here are the last ${screenshotsToSend.length} screenshots showing the progression of actions (most recent last):`
              }
            ];

            screenshotsToSend.forEach((image, idx) => {
              imageContent.push({
                type: 'image_url',
                image_url: {
                  url: image,
                  detail: 'low'
                }
              });
            });

            messages.push({
              role: 'user',
              content: imageContent
            } as any);

            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCREENSHOTS] ✅ Added user message with ${screenshotsToSend.length} image(s)`);
          } else if (screenshotsToSend.length > 0) {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCREENSHOTS_SKIP] Skipping ${screenshotsToSend.length} screenshot(s) in iteration ${iterations} to reduce content filter risk`);
          }

          step.toolResults = toolResults;

          if (schema && toolResults.length > 0 && iterations >= 8 && iterations % 2 === 0) {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REMINDER] Adding gentle reminder to request structured output (iteration ${iterations})`);
            messages.push({
              role: 'user',
              content: `⚠️ REMINDER: When you complete the current step objective, provide your response in JSON format with event, step, and assistant_message fields.`
            });
          }
        }

        steps.push(step);

        if (onStep) {
          const streamingLogId = (response as any).streamingLogId;
          await onStep(step, streamingLogId ? { streamingLogId } : undefined);
        }

        const hasToolCalls = !!(message.tool_calls && message.tool_calls.length > 0);
        const shouldStop = (schema && finalOutput !== undefined) ||
                          !hasToolCalls ||
                          !!enforceSingleTurn;

        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Should stop: ${shouldStop} (finish_reason=${(response as any).finish_reason}, hasSchema=${!!schema}, hasOutput=${finalOutput !== undefined}, hasToolCalls=${hasToolCalls}, enforceSingleTurn=${!!enforceSingleTurn})`);

        const iterationEndTime = Date.now();
        const iterationDuration = iterationEndTime - iterationStartTime;
        console.log(`⏱️ [ITERATION_TOTAL] Iteration ${iterations} completed in ${iterationDuration}ms (${(iterationDuration/1000).toFixed(1)}s)`);
        console.log(`⏱️ ========== END ITERATION ${iterations} ==========\n`);

        if (shouldStop) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Breaking loop after ${iterations} iterations`);
          break;
        }

        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Continuing to next iteration...`);

      } catch (error: any) {
        if (error?.name === 'RecoveryError') throw error;
        console.error('[AI EXECUTOR] Execution stopped after an error');

        // Azure-specific content filter; other providers surface their own error shapes.
        if (error.code === 'content_filter' || error.message?.includes('content management policy')) {
          console.error(`❌ [CONTENT_FILTER][${provider}] Provider blocked the response due to content policy`);
          console.error('❌ [CONTENT_FILTER] This may be a false positive. Consider:');
          console.error('   1. Adjusting content filter settings in the provider console');
          console.error('   2. Reviewing recent screenshots for sensitive content');
          console.error('   3. Modifying the system prompt');

          return {
            messages,
            steps,
            text: 'Content filter triggered - execution stopped',
            output: schema ? {
              event: 'step_failed',
              step: iterations,
              assistant_message: `${provider} content filter triggered. The response was blocked due to content policy. This may be a false positive.`
            } : undefined,
            usage: totalUsage,
          };
        }

        if (error.message && error.message.includes('tool_call_id')) {
          console.error('⚠️ Tool call mismatch detected. Messages state:', JSON.stringify(messages.slice(-5), null, 2));
        }

        throw error;
      }
    }

    return {
      messages,
      steps,
      text: finalText,
      output: finalOutput,
      usage: totalUsage,
    };
  }

  /**
   * Convert Zod schema to JSON Schema for structured outputs.
   */
  private zodToJsonSchema(schema: z.ZodType<any>): Record<string, any> {
    const convert = (s: any): any => {
      if (s instanceof z.ZodObject) {
        const shape = s.shape;
        const properties: Record<string, any> = {};
        const required: string[] = [];

        for (const [key, value] of Object.entries(shape)) {
          properties[key] = convert(value);
          if (!(value as any).isOptional()) {
            required.push(key);
          }
        }

        return {
          type: 'object',
          properties,
          required,
          additionalProperties: false,
        };
      }

      if (s instanceof z.ZodString) {
        return { type: 'string' };
      }

      if (s instanceof z.ZodNumber) {
        return { type: 'number' };
      }

      if (s instanceof z.ZodBoolean) {
        return { type: 'boolean' };
      }

      if (s instanceof z.ZodArray) {
        return {
          type: 'array',
          items: convert(s.element),
        };
      }

      if (s instanceof z.ZodEnum) {
        return {
          type: 'string',
          enum: s.options,
        };
      }

      if (s instanceof z.ZodOptional) {
        return convert(s.unwrap());
      }

      if (s instanceof z.ZodNullable) {
        const inner = convert(s.unwrap());
        return {
          ...inner,
          nullable: true,
        };
      }

      return { type: 'string' };
    };

    return convert(schema);
  }
}

/**
 * Legacy alias. Prefer {@link AIAgentExecutor} in new code.
 * Kept as a class alias (not a `const`) so `new OpenAIAgentExecutor()` keeps working.
 */
export { AIAgentExecutor as OpenAIAgentExecutor };
