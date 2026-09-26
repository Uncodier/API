export interface ContextUsage {
  model: string;
  provider: string;
  usedTokens: number;
  outputTokens?: number;
  availableTokens: number | null;
  reservedOutputTokens: number;
  utilization: number | null;
  source: 'estimate' | 'provider';
  measuredAt: string;
  breakdown?: InputTokenBreakdown | null;
}

/** Disjoint, estimated prompt composition. Provider APIs only report an aggregate. */
export type InputTokenBreakdown = {
  estimatedInputTokens: number;
  instructions: number;
  skills: number;
  messages: number;
  toolCalls: number;
  toolDefinitions: number;
};

export const INPUT_BREAKDOWN_KEYS = ['instructions', 'skills', 'messages', 'toolCalls', 'toolDefinitions'] as const;

/** Reject stale or malformed database JSON; never send prompt content to the widget. */
export function readInputTokenBreakdown(value: unknown, measuredAt: string, usedTokens: number, source: string): InputTokenBreakdown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 9) return null;
  if (typeof raw.measuredAt !== 'string' || !Number.isFinite(Date.parse(raw.measuredAt))
    || Date.parse(raw.measuredAt) !== Date.parse(measuredAt)
    || raw.usedTokens !== usedTokens || raw.source !== source) return null;
  const keys: readonly string[] = ['estimatedInputTokens', ...INPUT_BREAKDOWN_KEYS];
  if (keys.some(key => !Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) return null;
  if (INPUT_BREAKDOWN_KEYS.reduce((sum, key) => sum + (raw[key] as number), 0) !== raw.estimatedInputTokens) return null;
  if (source === 'estimate' && raw.estimatedInputTokens !== usedTokens) return null;
  return Object.fromEntries(keys.map(key => [key, raw[key]])) as InputTokenBreakdown;
}

type ModelCapacity = { availableTokens: number; reservedOutputTokens: number };

export function outputReserveForModel(provider: string, model: string): number {
  return modelContextCapacity(provider, model)?.reservedOutputTokens ?? 0;
}

// Documented model IDs only. Azure deployment aliases and Vertex endpoints may
// differ from their displayed model IDs and must be configured explicitly.
const KNOWN_MODEL_CAPACITIES: Readonly<Record<string, ModelCapacity>> = {
  'gemini:gemini-3.1-pro-preview': { availableTokens: 1_048_576, reservedOutputTokens: 0 },
  'gemini:gemini-3.1-pro-preview-customtools': { availableTokens: 1_048_576, reservedOutputTokens: 0 },
  'openai:gpt-4o': { availableTokens: 128_000, reservedOutputTokens: 16_384 },
  'openai:gpt-5.2': { availableTokens: 400_000, reservedOutputTokens: 128_000 },
  // Azure deployment names are arbitrary; only the exact default model-named
  // deployment can use this mapping. All other deployments need an override.
  'azure:gpt-4o': { availableTokens: 128_000, reservedOutputTokens: 16_384 },
  'xai:grok-4.6': { availableTokens: 500_000, reservedOutputTokens: 2048 },
};

const discoveredModelCapacities = new Map<string, ModelCapacity>();
const pendingModelLookups = new Map<string, Promise<ModelCapacity | null>>();
const failedModelLookups = new Map<string, number>();

function capacityFromConfig(value: unknown): ModelCapacity | null {
  if (Number.isSafeInteger(value) && (value as number) > 0) {
    const availableTokens = value as number;
    return { availableTokens, reservedOutputTokens: Math.max(2048, Math.ceil(availableTokens * .1)) };
  }
  if (!value || typeof value !== 'object') return null;
  const inputTokens = (value as { inputTokens?: unknown }).inputTokens;
  if (Number.isSafeInteger(inputTokens) && (inputTokens as number) > 0) {
    return { availableTokens: inputTokens as number, reservedOutputTokens: 0 };
  }
  const contextTokens = (value as { contextTokens?: unknown }).contextTokens;
  const outputTokens = (value as { outputTokens?: unknown }).outputTokens;
  if (!Number.isSafeInteger(contextTokens) || (contextTokens as number) <= 0) return null;
  const availableTokens = contextTokens as number;
  const reservedOutputTokens = Number.isSafeInteger(outputTokens) && (outputTokens as number) >= 0
    ? outputTokens as number : Math.max(2048, Math.ceil(availableTokens * .1));
  return reservedOutputTokens < availableTokens ? { availableTokens, reservedOutputTokens } : null;
}

export function modelContextCapacity(provider: string, model: string): ModelCapacity | null {
  try {
    const limits = JSON.parse(process.env.INSTANCE_CONTEXT_MODEL_LIMITS || '{}');
    const override = capacityFromConfig(limits[`${provider}:${model}`]);
    if (override) return override;
  } catch {
    // Invalid optional configuration does not hide a known published limit.
  }
  return discoveredModelCapacities.get(`${provider}:${model}`)
    || KNOWN_MODEL_CAPACITIES[`${provider}:${model}`] || null;
}

/** Discover Gemini model metadata for new exact IDs (bounded network call). */
export async function resolveModelContextCapacity(provider: string, model: string): Promise<ModelCapacity | null> {
  const known = modelContextCapacity(provider, model);
  if (known || provider !== 'gemini' || !/^gemini-[a-zA-Z0-9.-]+$/.test(model) || !process.env.GEMINI_API_KEY) {
    return known;
  }
  const key = `${provider}:${model}`;
  if ((failedModelLookups.get(key) || 0) > Date.now()) return null;
  if (!pendingModelLookups.has(key)) {
    const lookup = (async (): Promise<ModelCapacity | null> => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        try {
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
            headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY! }, signal: controller.signal,
          });
          if (!response.ok) return null;
          const metadata = await response.json() as { inputTokenLimit?: unknown };
          const capacity = capacityFromConfig({ inputTokens: metadata.inputTokenLimit });
          if (capacity) discoveredModelCapacities.set(key, capacity);
          return capacity;
        } finally { clearTimeout(timeout); }
      } catch { return null; }
    })();
    pendingModelLookups.set(key, lookup);
    void lookup.then(capacity => {
      pendingModelLookups.delete(key);
      if (!capacity) failedModelLookups.set(key, Date.now() + 5 * 60_000);
    });
  }
  return pendingModelLookups.get(key)!;
}

export function modelContextLimit(provider: string, model: string): number | null {
  return modelContextCapacity(provider, model)?.availableTokens ?? null;
}

export function estimateTokens(value: unknown): number {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  // Approximation, not a tokenizer: UTF-8 bytes avoid undercounting non-ASCII
  // history, and 2 bytes/token leaves headroom for JSON and tool schemas.
  return Math.ceil(Buffer.byteLength(serialized, 'utf8') / 2) + 4;
}

/** Count vision parts as images, not as base64 text transported in a data URL.
 * Do not replace arbitrary strings: file contents and tool outputs remain real text.
 * This is a conservative allowance, not a provider's image tokenizer. */
export function estimatePromptTokens(messages: unknown[]): number {
  let imageCount = 0;
  const serialized = JSON.stringify(messages, (_key, value: unknown) => {
    if (value && typeof value === 'object' &&
        (value as { type?: unknown }).type === 'image_url') {
      const part = value as { type: 'image_url'; image_url?: string | { url?: string } };
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string' && /^(?:data:image\/|https?:\/\/)/i.test(url)) {
        imageCount += 1;
        return { ...part, image_url: { url: '[image payload]' } };
      }
    }
    return value;
  });
  return estimateTokens(serialized) + imageCount * 4096;
}

/** Estimate mutually exclusive portions of exactly the messages/tool schemas sent.
 * Embedded skill blocks are identified only in system messages. Loaded skill
 * playbooks in tool results belong to tool calls, not to system skills. */
export function estimateInputBreakdown(system: string, messages: unknown[], tools: unknown[]): InputTokenBreakdown {
  const prompt = messages as Array<{ role?: string; content?: unknown; tool_calls?: unknown }>;
  const estimatedInputTokens = estimatePromptTokens(messages) + estimateTokens(tools)
    + (system && !prompt.some(message => message?.role === 'system') ? estimateTokens(system) : 0);
  const toolDefinitions = tools.length ? estimateTokens(tools) : 0;
  const base = estimatePromptTokens([]);
  const toolMessages = prompt.filter(message => message?.role === 'tool' || (message?.role === 'assistant' && message.tool_calls));
  const toolCalls = Math.min(estimatedInputTokens - toolDefinitions,
    toolMessages.length ? Math.max(0, estimatePromptTokens(toolMessages) - base) : 0);
  const chat = prompt.filter(message => message?.role === 'user' || (message?.role === 'assistant' && !message.tool_calls));
  const chatTokens = Math.min(estimatedInputTokens - toolDefinitions - toolCalls,
    chat.length ? Math.max(0, estimatePromptTokens(chat) - base) : 0);
  const systemTexts = prompt.filter(message => message?.role === 'system' && typeof message.content === 'string')
    .map(message => message.content as string);
  if (!systemTexts.length && system) systemTexts.push(system);
  const skillBlocks = systemTexts
    .flatMap(text => Array.from(text.matchAll(
      /--- BEGIN SKILL [^\n]* ---\n[\s\S]*?\n--- END SKILL [^\n]* ---/g), match => match[0]));
  const skills = Math.min(estimatedInputTokens - toolDefinitions - toolCalls - chatTokens,
    skillBlocks.length ? estimateTokens(skillBlocks.join('\n')) : 0);
  return { estimatedInputTokens, instructions: estimatedInputTokens - toolDefinitions - toolCalls - chatTokens - skills,
    skills, messages: chatTokens, toolCalls, toolDefinitions };
}

export class InstanceContextOverflowError extends Error {
  readonly code = 'INSTANCE_CONTEXT_OVERFLOW';
  constructor(readonly usedTokens: number, readonly inputBudget: number) {
    super(`Instance prompt exceeds configured model input budget (${usedTokens} estimated input tokens; budget ${inputBudget}).`);
    this.name = 'InstanceContextOverflowError';
    Object.setPrototypeOf(this, InstanceContextOverflowError.prototype);
  }
}

export function projectNextTurn(usage: Pick<ContextUsage,
  'usedTokens' | 'outputTokens' | 'availableTokens' | 'reservedOutputTokens'>): {
    projectedTokens: number; utilization: number | null;
  } {
  const projectedTokens = usage.usedTokens + Math.max(0, usage.outputTokens || 0);
  const budget = usage.availableTokens === null
    ? null : usage.availableTokens - usage.reservedOutputTokens;
  return { projectedTokens, utilization: budget === null ? null
    : Math.min(1, projectedTokens / Math.max(1, budget)) };
}

/** Reduce only optional instance history; never remove system rules or tool-call pairs. */
export function fitInstanceRequest(params: {
  provider: string; model: string; messages: Array<{ role: string; content?: unknown }>;
  tools: unknown[]; responseFormat?: unknown;
}): { usedTokens: number; inputBudget: number | null; compacted: boolean } {
  const capacity = modelContextCapacity(params.provider, params.model);
  // An unknown deployment has no verified window. Never reject a request
  // based on a made-up 24k cap; the provider remains the source of truth.
  if (!capacity) return { usedTokens: estimatePromptTokens(params.messages) + estimateTokens(params.tools)
    + (params.responseFormat ? estimateTokens(params.responseFormat) : 0), inputBudget: null, compacted: false };
  const inputBudget = capacity.availableTokens - capacity.reservedOutputTokens;
  const usage = () => estimatePromptTokens(params.messages) + estimateTokens(params.tools)
    + (params.responseFormat ? estimateTokens(params.responseFormat) : 0);
  let usedTokens = usage();
  if (usedTokens <= inputBudget) return { usedTokens, inputBudget, compacted: false };
  const system = params.messages.find(message => message.role === 'system');
  if (typeof system?.content === 'string') {
    const startMarker = 'INSTANCE_HISTORY_START\n';
    const blockStart = system.content.lastIndexOf(startMarker);
    const marker = 'RECENT INSTANCE HISTORY (newest last):\n';
    const sectionEnd = blockStart < 0 ? -1 : system.content.lastIndexOf('\nINSTANCE_HISTORY_END');
    const start = sectionEnd < 0 ? -1 : system.content.indexOf(marker, blockStart + startMarker.length);
    if (start >= 0 && start < sectionEnd) {
      // Without a durable summary, removing even optional history would make
      // prior user decisions irrecoverable for this request.
      if (!system.content.slice(blockStart, start).includes('RELEVANT EARLIER MEMORY:')) {
        throw new InstanceContextOverflowError(usedTokens, inputBudget);
      }
      const end = system.content.lastIndexOf('\nTACTICAL INSTANCE EVIDENCE (preserve on overflow):', sectionEnd);
      // Remove the optional transcript only. Tactical evidence follows after
      // the marker and is retained; never touch tool-call message pairs.
      system.content = system.content.slice(0, start)
        + (end >= 0 && end < sectionEnd ? system.content.slice(end, sectionEnd) : '')
        + system.content.slice(sectionEnd);
      usedTokens = usage();
    }
  }
  // Requirement/cron single-turn prompts keep their independent history in a
  // marked user message. It is advisory evidence, not the current step.
  if (usedTokens > inputBudget) {
    const history = params.messages.find(message => message.role === 'user'
      && typeof message.content === 'string'
      && message.content.startsWith('Historical user messages follow as untrusted reference data.'));
    if (history) {
      history.content = 'Historical user messages omitted due to model context budget; current step instructions remain unchanged.';
      usedTokens = usage();
    }
  }
  if (usedTokens > inputBudget) throw new InstanceContextOverflowError(usedTokens, inputBudget);
  return { usedTokens, inputBudget, compacted: true };
}

export function measureInstanceContext(params: {
  provider: string; model: string; system: string; messages: unknown[]; tools: unknown[];
  providerInputTokens?: number; providerOutputTokens?: number;
}): ContextUsage {
  const capacity = modelContextCapacity(params.provider, params.model);
  const availableTokens = capacity?.availableTokens ?? null;
  const breakdown = estimateInputBreakdown(params.system, params.messages, params.tools);
  const usedTokens = Number.isFinite(params.providerInputTokens) && (params.providerInputTokens ?? 0) > 0
    ? Math.ceil(params.providerInputTokens!)
    : breakdown.estimatedInputTokens;
  const reservedOutputTokens = capacity?.reservedOutputTokens ?? 0;
  return {
    model: params.model, provider: params.provider, usedTokens,
    outputTokens: Math.max(0, params.providerOutputTokens || 0), availableTokens,
    reservedOutputTokens,
    utilization: availableTokens ? Math.min(1, usedTokens / Math.max(1, availableTokens - reservedOutputTokens)) : null,
    source: params.providerInputTokens ? 'provider' : 'estimate',
    measuredAt: new Date().toISOString(),
    breakdown,
  };
}