/**
 * AI Agent Executor
 *
 * Provider-agnostic agent executor that reuses the OpenAI chat completions
 * protocol (with tool calling) but can target Gemini (default), Azure OpenAI
 * or OpenAI via the same client.
 *
 * Provider selection order:
 *   1. `config.provider` (constructor arg)
 *   2. `process.env.AI_PROVIDER`
 *   3. `'gemini'` (default)
 *
 * For Gemini we use Google's OpenAI-compatible endpoint
 * (`https://generativelanguage.googleapis.com/v1beta/openai/`) so tool calling
 * and streaming keep working unchanged.
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

import OpenAI from 'openai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ensureAzureSafeDataImageUrl,
  isAzureInvalidImageError,
  sanitizeMessagesForAzureVisionImages,
} from './azure-vision-message-sanitize';
import { sanitizeMessagesForGemini } from './gemini-message-sanitize';

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

/**
 * Helper function to filter base64 images in messages, keeping only the latest ones up to specified limit.
 * This prevents the context window from growing infinitely with accumulated screenshots.
 * Based on Scrapybara's implementation pattern.
 *
 * @param messages - List of messages to filter (modifies in place)
 * @param imagesToKeep - Maximum number of images to keep
 */
function filterImages(messages: any[], imagesToKeep: number): void {
  let imagesKept = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const contentPart = msg.content[j];

        if (contentPart.type === 'image_url' && contentPart.image_url) {
          const imageUrl = contentPart.image_url.url;
          if (imageUrl && (imageUrl.startsWith('data:image/') || imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
            if (imagesKept < imagesToKeep) {
              imagesKept++;
            } else {
              msg.content.splice(j, 1);
            }
          } else {
            console.log(`🧹 [IMAGE_FILTER] Removing invalid image URL: ${imageUrl?.substring(0, 100)}...`);
            msg.content.splice(j, 1);
          }
        }
      }

      if (msg.content.length === 0) {
        messages.splice(i, 1);
      } else if (msg.content.length === 1 && msg.content[0].type === 'text' &&
                 msg.content[0].text.includes('Here are the')) {
        messages.splice(i, 1);
      }
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
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  output?: any;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
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
}

export interface Tool {
  name: string;
  description?: string;
  parameters?: Record<string, any> | z.ZodType<any>;
  execute: (args: any) => Promise<any>;
}

export interface ActOptions {
  model?: string;
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
  onStreamChunk?: (logId: string, accumulatedText: string) => Promise<void>;
  onThinkingStreamStart?: () => Promise<string>;
  onThinkingStreamChunk?: (logId: string, accumulatedText: string) => Promise<void>;
  onReasoningTokensUsed?: (reasoningTokensCount: number) => Promise<void>;
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
  };
}

export type AIProvider = 'gemini' | 'azure' | 'openai';

export interface AIAgentExecutorConfig {
  /** Provider to use. Defaults to process.env.AI_PROVIDER ?? 'gemini'. */
  provider?: AIProvider;
  /** Model id. Defaults to process.env.AI_MODEL or a provider-specific default. */
  model?: string;
  /** Provider API key. Falls back to provider-specific env var. */
  apiKey?: string;
  /** Base URL override. Useful for self-hosted OpenAI-compatible gateways. */
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

const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Produce a rich diagnostic line for a failed chat.completions.create call.
 * OpenAI SDK APIError messages like "400 status code (no body)" give us
 * virtually nothing useful on their own; this helper pulls out the request id,
 * provider headers, base URL, model, message count and rough payload size so
 * we can actually troubleshoot provider-side rejections (bad model id,
 * context-window overflow, invalid tool schema, etc.).
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
  const e = err as {
    status?: number;
    message?: string;
    code?: string;
    type?: string;
    param?: string;
    request_id?: string;
    headers?: Record<string, string> | Headers;
    error?: unknown;
    response?: { status?: number; headers?: unknown; data?: unknown };
    cause?: unknown;
  } | undefined;

  const headersObj: Record<string, string> = {};
  const rawHeaders = e?.headers;
  try {
    if (rawHeaders && typeof (rawHeaders as Headers).forEach === 'function') {
      (rawHeaders as Headers).forEach((value: string, key: string) => {
        if (
          key.startsWith('x-') ||
          key === 'content-type' ||
          key === 'content-length' ||
          key === 'server'
        ) {
          headersObj[key] = value;
        }
      });
    } else if (rawHeaders && typeof rawHeaders === 'object') {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
        if (
          k.startsWith('x-') ||
          k.toLowerCase() === 'content-type' ||
          k.toLowerCase() === 'content-length' ||
          k.toLowerCase() === 'server'
        ) {
          headersObj[k] = String(v);
        }
      }
    }
  } catch {
    /* ignore header introspection errors */
  }

  let approxPayloadChars: number | undefined;
  if (Array.isArray(ctx.messages)) {
    try {
      approxPayloadChars = JSON.stringify(ctx.messages).length;
    } catch {
      approxPayloadChars = undefined;
    }
  }

  // When the provider returns 400 with an empty body (Gemini's
  // openai-compat layer does this often) the only way to diagnose the
  // rejection is to inspect what we sent. Attach a compact preview of the
  // last few messages and the tool names so operators can spot the offender
  // (e.g. tool with unresolved parameters, malformed image, null content).
  const isEmptyBody400 =
    e?.status === 400 &&
    (!e?.error || (typeof e?.message === 'string' && /no body|400 status code \(no body\)/i.test(e.message)));

  const TRUNCATE = (s: string, n = 600): string => (s.length > n ? s.slice(0, n) + '…' : s);
  const previewMessage = (m: any) => {
    if (!m || typeof m !== 'object') return { role: '?', content: String(m) };
    const out: Record<string, unknown> = { role: m.role };
    if (m.name) out.name = String(m.name).slice(0, 64);
    if (m.tool_call_id) out.tool_call_id = String(m.tool_call_id).slice(0, 64);
    if (Array.isArray(m.tool_calls)) {
      out.tool_calls = m.tool_calls.map((tc: any) => ({
        id: tc?.id,
        name: tc?.function?.name,
        argsPreview: typeof tc?.function?.arguments === 'string' ? TRUNCATE(tc.function.arguments, 200) : tc?.function?.arguments,
      }));
    }
    if (typeof m.content === 'string') {
      out.content = TRUNCATE(m.content, 800);
    } else if (Array.isArray(m.content)) {
      out.content = m.content.map((p: any) => {
        if (!p || typeof p !== 'object') return p;
        if (p.type === 'text') return { type: 'text', text: TRUNCATE(String(p.text ?? ''), 400) };
        if (p.type === 'image_url') {
          const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
          return {
            type: 'image_url',
            urlPreview: typeof url === 'string' ? url.slice(0, 64) + (url.length > 64 ? '…' : '') : typeof url,
            urlBytes: typeof url === 'string' ? url.length : null,
          };
        }
        return { type: p.type };
      });
    } else if (m.content === null || m.content === undefined) {
      out.content = m.content;
    } else {
      out.content = `[${typeof m.content}]`;
    }
    return out;
  };

  let messagesPreview: unknown[] | undefined;
  if (isEmptyBody400 && Array.isArray(ctx.messages)) {
    const tail = ctx.messages.slice(-4);
    messagesPreview = tail.map(previewMessage);
  }

  let toolNames: string[] | undefined;
  if (isEmptyBody400 && Array.isArray(ctx.tools)) {
    toolNames = ctx.tools
      .map((t: any) => t?.function?.name || t?.name)
      .filter((x: unknown): x is string => typeof x === 'string')
      .slice(0, 30);
  }

  const payload = {
    provider: ctx.provider,
    stage: ctx.stage,
    baseURL: ctx.baseURL,
    model: ctx.modelName,
    messageCount: Array.isArray(ctx.messages) ? ctx.messages.length : undefined,
    approxPayloadChars,
    toolCount: ctx.toolCount,
    status: e?.status,
    code: e?.code,
    type: e?.type,
    param: e?.param,
    request_id: e?.request_id,
    headers: Object.keys(headersObj).length > 0 ? headersObj : undefined,
    errorMessage: e?.message,
    errorBody: e?.error,
    ...(messagesPreview ? { messagesPreview } : {}),
    ...(toolNames ? { toolNames } : {}),
  };

  console.error(
    `❌ [LLM_ERROR][${ctx.provider}][${ctx.stage}] chat.completions.create failed:`,
    JSON.stringify(payload, null, 2),
  );
}

const DEFAULT_MODEL_BY_PROVIDER: Record<AIProvider, string> = {
  gemini: 'gemini-3.1-pro-preview',
  azure: 'gpt-4o',
  openai: 'gpt-4o',
};

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

  constructor(config?: AIAgentExecutorConfig | string) {
    // Back-compat: string arg is treated as an API key for the selected provider.
    if (typeof config === 'string') {
      config = { apiKey: config };
    }

    const provider = this.resolveProvider(config?.provider);
    this.provider = provider;

    if (provider === 'azure') {
      const apiKey = config?.apiKey || process.env.MICROSOFT_AZURE_OPENAI_API_KEY;
      const endpoint = config?.endpoint || process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT;
      const deployment = config?.deployment || process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT || DEFAULT_MODEL_BY_PROVIDER.azure;
      const apiVersion = config?.apiVersion || process.env.MICROSOFT_AZURE_OPENAI_API_VERSION || '2024-08-01-preview';

      if (!endpoint) {
        throw new Error('Azure OpenAI endpoint is required. Set MICROSOFT_AZURE_OPENAI_ENDPOINT environment variable.');
      }
      if (!apiKey) {
        throw new Error('Azure OpenAI API key is required. Set MICROSOFT_AZURE_OPENAI_API_KEY environment variable.');
      }

      this.client = new OpenAI({
        apiKey,
        baseURL: `${endpoint}/openai/deployments/${deployment}`,
        defaultQuery: { 'api-version': apiVersion },
        defaultHeaders: { 'api-key': apiKey },
      });

      // For Azure the model in the body is informational (deployment is in baseURL).
      this.model = config?.model || process.env.AI_MODEL || deployment;
    } else if (provider === 'openai') {
      const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
      const baseURL = config?.baseURL || process.env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL;

      if (!apiKey) {
        throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable.');
      }

      this.client = new OpenAI({ apiKey, baseURL });
      this.model = config?.model || process.env.AI_MODEL || DEFAULT_MODEL_BY_PROVIDER.openai;
    } else {
      // Gemini via OpenAI-compatible endpoint (default).
      const apiKey = config?.apiKey || process.env.GEMINI_API_KEY;
      const baseURL = config?.baseURL || process.env.GEMINI_OPENAI_BASE_URL || GEMINI_DEFAULT_BASE_URL;

      if (!apiKey) {
        throw new Error('Gemini API key is required. Set GEMINI_API_KEY environment variable.');
      }

      this.client = new OpenAI({ apiKey, baseURL });
      this.model = config?.model || process.env.AI_MODEL || DEFAULT_MODEL_BY_PROVIDER.gemini;
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [AI EXECUTOR] provider=${this.provider} model=${this.model}`);
  }

  private resolveProvider(explicit?: AIProvider): AIProvider {
    const raw = (explicit || process.env.AI_PROVIDER || 'gemini').toLowerCase();
    if (raw === 'azure' || raw === 'openai' || raw === 'gemini') {
      return raw;
    }
    console.warn(`₍ᐢ•(ܫ)•ᐢ₎ [AI EXECUTOR] Unknown AI_PROVIDER="${raw}", falling back to 'gemini'`);
    return 'gemini';
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
      onStreamChunk: (logId: string, text: string) => Promise<void>;
      onThinkingStreamStart?: () => Promise<string>;
      onThinkingStreamChunk?: (logId: string, text: string) => Promise<void>;
      onReasoningTokensUsed?: (count: number) => Promise<void>;
    },
    totalUsage: { promptTokens: number; completionTokens: number; totalTokens: number }
  ): Promise<{
    message: any;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    finish_reason?: string;
    streamingLogId?: string;
  }> {
    const opts = {
      ...completionOptions,
      stream: true,
    };
    const stream = await this.client.chat.completions.create(opts as any).catch(err => {
      console.error(`❌ [AI STREAM INIT ERROR][${this.provider}]`, err.message);
      if (err.status) console.error(`   Status: ${err.status}`);
      if (err.headers) console.error(`   Headers:`, JSON.stringify(err.headers, null, 2));
      if (err.error) console.error(`   Error object:`, JSON.stringify(err.error, null, 2));
      throw err;
    });

    let content = '';
    let reasoningContent = '';
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
      if (chunk.usage) {
        usage = chunk.usage;
        totalUsage.promptTokens += chunk.usage.prompt_tokens || 0;
        totalUsage.completionTokens += chunk.usage.completion_tokens || 0;
        totalUsage.totalTokens += chunk.usage.total_tokens || 0;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta || {};

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
      await callbacks.onStreamChunk(streamingLogId, content);
    }
    if (thinkingLogId && reasoningContent && callbacks.onThinkingStreamChunk) {
      await callbacks.onThinkingStreamChunk(thinkingLogId, reasoningContent);
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

    return { message, usage, finish_reason: finishReason, streamingLogId };
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
    } = options;

    const modelName = model || this.model;
    const provider = this.provider;
    // Azure/OpenAI reasoning-tuned models accept extra params (reasoning_effort,
    // verbosity, no temperature override). Gemini does NOT — skip all that.
    const supportsReasoningParams = provider === 'azure' || provider === 'openai';
    const isReasoningModel = supportsReasoningParams && (
      modelName.includes('o1') || modelName.includes('o3') || modelName.includes('gpt-5.4')
    );

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
    let totalUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
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
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [IMAGE_FILTER] Cleaned ${imagesBefore - imagesAfter} old image(s), kept ${imagesAfter} most recent`);
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
        };

        // After enough iterations with a schema, drop tools to force JSON output.
        const shouldForceJson = schema && iterations > 15;

        if (!shouldForceJson && openaiTools.length > 0) {
          completionOptions.tools = openaiTools;
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Including tools in API call`);
        } else if (shouldForceJson) {
          console.log(`⚠️ [EXECUTOR] Forcing JSON output - removing tools (iteration ${iterations})`);
        }

        // Temperature: Azure reasoning models reject non-default values; Gemini accepts it.
        if (!isReasoningModel && temperature !== 1) {
          completionOptions.temperature = temperature;
        }

        // reasoning_effort / verbosity only for Azure/OpenAI o-series style deployments.
        if (isReasoningModel) {
          if (modelName === 'o3-mini' || modelName === 'o1') {
            completionOptions.reasoning_effort = reasoningEffort;
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Using reasoning_effort=${reasoningEffort} for model: ${modelName}`);
          } else {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Skipping reasoning_effort for model: ${modelName}`);
          }
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

        console.log(`🔍 [DEBUG] First 2000 chars of messages:`, JSON.stringify(messages, null, 2).substring(0, 2000));

        const useStreamingPath = useStreaming && onStreamStart && onStreamChunk && !schema;
        const useThinkingStream = useStreamingPath && onThinkingStreamStart && onThinkingStreamChunk;

        const optsForLog = { ...completionOptions, stream: useStreamingPath, stream_options: undefined, messages: `[${messages.length} messages omitted]` };
        console.log(`🔍 [DEBUG][${provider}] API Payload Options:`, JSON.stringify(optsForLog, null, 2));

        let response: { message: any; usage?: any; finish_reason?: string };

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
              streamCallbacks,
              totalUsage
            );
          } catch (streamError: any) {
            console.error(`❌ [STREAM_ERROR][${provider}] Streaming failed (${streamError.status || streamError.message}), falling back to non-streaming...`);
            logChatCompletionFailure(streamError, {
              provider,
              stage: 'stream',
              baseURL: (this.client as any)?.baseURL,
              modelName,
              messages,
              toolCount: openaiTools.length,
              tools: openaiTools,
            });

            if (provider === 'azure' && isAzureInvalidImageError(streamError)) {
              sanitizeMessagesForAzureVisionImages(messages);
              console.warn(
                `₍ᐢ•(ܫ)•ᐢ₎ [AZURE_VISION] Re-sanitized messages after invalid image on stream; using non-streaming fallback`
              );
            }

            console.log(`⏱️ [TIMING] Calling ${provider.toUpperCase()} API with NON-streaming fallback...`);
            const fallbackOptions = { ...completionOptions };
            delete fallbackOptions.stream;
            delete fallbackOptions.stream_options;

            const apiStartTime = Date.now();
            let completion;
            try {
              completion = await this.client.chat.completions.create(fallbackOptions);
            } catch (fallbackErr: any) {
              if (provider === 'azure' && isAzureInvalidImageError(fallbackErr)) {
                sanitizeMessagesForAzureVisionImages(messages);
                completion = await this.client.chat.completions.create(fallbackOptions);
              } else {
                logChatCompletionFailure(fallbackErr, {
                  provider,
                  stage: 'fallback',
                  baseURL: (this.client as any)?.baseURL,
                  modelName,
                  messages,
                  toolCount: openaiTools.length,
                  tools: openaiTools,
                });
                throw fallbackErr;
              }
            }
            const apiEndTime = Date.now();
            const apiDuration = apiEndTime - apiStartTime;
            console.log(`⏱️ [TIMING][${provider}] Fallback response received in ${apiDuration}ms (${(apiDuration/1000).toFixed(1)}s)`);

            const choice = completion.choices[0];
            response = {
              message: choice.message,
              usage: completion.usage,
              finish_reason: choice.finish_reason ?? undefined,
            } as any;

            if (choice.message.content) {
              const streamingLogId = await onStreamStart!();
              await onStreamChunk!(streamingLogId, choice.message.content);
            }
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
            finish_reason: choice.finish_reason ?? undefined,
          } as any;
        }

        const message = response.message;

        if (response.usage) {
          totalUsage.promptTokens += response.usage.prompt_tokens;
          totalUsage.completionTokens += response.usage.completion_tokens;
          totalUsage.totalTokens += response.usage.total_tokens;
        }

        messages.push(message as Message);

        const step: Step = {
          text: message.content || '',
          usage: {
            promptTokens: response.usage?.prompt_tokens || 0,
            completionTokens: response.usage?.completion_tokens || 0,
            totalTokens: response.usage?.total_tokens || 0,
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
              toolCalls.push({
                toolCallId: tc.id,
                toolName: tc.function.name,
                args: parsed.value,
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
              messages.push({
                role: 'tool',
                tool_call_id: bad.id,
                name: bad.name,
                content: `Error parsing tool call arguments: ${bad.error}. The arguments string was not valid JSON. Re-issue the tool call with a single, well-formed JSON object.`,
              });
            }

            // If NONE of the tool calls were parseable, skip executor work and
            // let the next iteration retry. Otherwise, proceed to execute the
            // ones that did parse — the unparseable ones already have their
            // tool message above.
            if (toolCalls.length === 0) {
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

            try {
              let result: any;

              // Execute wait actions locally instead of round-trip to Scrapybara.
              if (toolCall.toolName === 'computer' && toolCall.args.action === 'wait') {
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

                result = await tool.execute(toolCall.args);

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

              toolResults.push({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result,
                base64Image: base64Image,
                cleanedResult: cleanedResult,
                isError: false,
              });

              messages.push({
                role: 'tool',
                tool_call_id: toolCall.toolCallId,
                name: toolCall.toolName,
                content: typeof cleanedResult === 'string' ? cleanedResult : JSON.stringify(cleanedResult),
              });

              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_MSG] ✅ Added tool message for ${toolCall.toolCallId}`);

            } catch (error: any) {
              const toolEndTime = Date.now();
              const toolDuration = toolEndTime - toolStartTime;
              const errorMessage = error.message || String(error);
              console.error(`⏱️ [TOOL_ERROR] ${toolCall.toolName} (${toolCall.toolCallId}) failed after ${toolDuration}ms (${(toolDuration/1000).toFixed(1)}s) - ${errorMessage.substring(0, 100)}`);

              toolResults.push({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result: errorMessage,
                isError: true,
              });

              messages.push({
                role: 'tool',
                tool_call_id: toolCall.toolCallId,
                name: toolCall.toolName,
                content: `Error: ${errorMessage}`,
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

        const shouldStop = (response as any).finish_reason === 'stop' ||
                          (schema && finalOutput !== undefined) ||
                          !message.tool_calls;

        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Should stop: ${shouldStop} (finish_reason=${response.finish_reason}, hasSchema=${!!schema}, hasOutput=${finalOutput !== undefined}, hasToolCalls=${!!message.tool_calls})`);

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
        console.error('Error in agent execution:', error);

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
