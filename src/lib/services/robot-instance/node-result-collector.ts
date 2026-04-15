/**
 * Node Result Collector
 *
 * Extensible registry that extracts structured outputs from agent tool calls
 * and packs them together with the LLM text into a single node result.
 *
 * Usage:
 *   import { buildNodeResult, registerExtractor } from './node-result-collector';
 *
 *   // Register a custom extractor (one-time, at module level)
 *   registerExtractor('my_tool', (toolResult) => ({
 *     type: 'custom',
 *     data: { ... },
 *   }));
 *
 *   // After execution
 *   const result = buildNodeResult(executionResult.text, 'done', executionResult.steps);
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodeToolOutput {
  tool_name: string;
  /** Broad category: 'image' | 'video' | 'audio' | 'data' | <custom> */
  type: string;
  data: Record<string, any>;
}

export interface NodeResult {
  text: string;
  status: 'running' | 'streaming' | 'done';
  outputs?: NodeToolOutput[];
}

/**
 * An extractor receives the raw tool result object and returns
 * one or more NodeToolOutput entries, or null if nothing to extract.
 */
export type ToolOutputExtractor = (
  raw: Record<string, any>,
  toolName: string,
) => NodeToolOutput[] | NodeToolOutput | null;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, ToolOutputExtractor>();

export function registerExtractor(toolName: string, extractor: ToolOutputExtractor): void {
  registry.set(toolName, extractor);
}

export function getExtractor(toolName: string): ToolOutputExtractor | undefined {
  return registry.get(toolName);
}

// ---------------------------------------------------------------------------
// Built-in extractors
// ---------------------------------------------------------------------------

registerExtractor('generate_image', (raw) => {
  if (!raw.success || !Array.isArray(raw.images)) return null;
  return raw.images.map((img: any) => ({
    tool_name: 'generate_image',
    type: 'image' as const,
    data: {
      url: typeof img === 'string' ? img : img?.url,
      provider: raw.provider,
      metadata: raw.metadata,
    },
  }));
});

registerExtractor('generate_video', (raw) => {
  if (!raw.success || !Array.isArray(raw.videos)) return null;
  return raw.videos.map((vid: any) => ({
    tool_name: 'generate_video',
    type: 'video' as const,
    data: {
      url: typeof vid === 'string' ? vid : vid?.url,
      mimeType: vid?.mimeType,
      provider: raw.provider,
      metadata: raw.metadata,
    },
  }));
});

// Future-proof: TTS / audio generation
registerExtractor('generate_audio', (raw) => {
  if (!raw.success || !raw.audio_url) return null;
  return {
    tool_name: 'generate_audio',
    type: 'audio',
    data: {
      url: raw.audio_url,
      mimeType: raw.mimeType,
      provider: raw.provider,
      metadata: raw.metadata,
    },
  };
});

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Walk through all steps/toolResults and collect structured outputs
 * using the registered extractors.
 */
export function collectToolOutputs(steps: any[]): NodeToolOutput[] {
  const outputs: NodeToolOutput[] = [];
  if (!steps || !Array.isArray(steps)) return outputs;

  for (const step of steps) {
    if (!step.toolResults || !Array.isArray(step.toolResults)) continue;

    for (const tr of step.toolResults) {
      if (tr.isError) continue;
      const raw = tr.cleanedResult ?? tr.result;
      if (!raw || typeof raw !== 'object') continue;

      const extractor = registry.get(tr.toolName);
      if (!extractor) continue;

      const extracted = extractor(raw, tr.toolName);
      if (!extracted) continue;

      if (Array.isArray(extracted)) {
        outputs.push(...extracted);
      } else {
        outputs.push(extracted);
      }
    }
  }

  return outputs;
}

/**
 * Build the final node result object that gets persisted to instance_nodes.result.
 * Combines the LLM text with any structured tool outputs.
 */
export function buildNodeResult(
  text: string,
  status: 'streaming' | 'done',
  steps?: any[],
): NodeResult {
  const result: NodeResult = { text, status };
  if (steps) {
    const outputs = collectToolOutputs(steps);
    if (outputs.length > 0) {
      result.outputs = outputs;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Output-type mapping  (output_type string -> tool_name)
// Used to pre-populate result.outputs when creating response nodes so the
// frontend knows the expected output shape before the LLM finishes.
// ---------------------------------------------------------------------------

const OUTPUT_TYPE_TO_TOOL: Record<string, string> = {
  image: 'generate_image',
  video: 'generate_video',
  audio: 'generate_audio',
};

/**
 * Build the initial `result` for a response node at creation time.
 *
 * Reads `promptNode.settings.output_type` (string or string[]) to determine
 * what kind of outputs the node is expected to produce.  Creates placeholder
 * entries in `outputs` so the frontend can render the correct UI immediately.
 *
 * Convention — the frontend sets `settings.output_type` on the prompt node:
 *   - 'image'          → one placeholder  { type: 'image', … }
 *   - 'video'          → one placeholder  { type: 'video', … }
 *   - ['image','audio'] → two placeholders
 *   - undefined / 'text' → no outputs array (plain text response)
 */
export function buildInitialNodeResult(promptNode: any): NodeResult {
  const result: NodeResult = { text: '', status: 'running' };

  const raw = promptNode?.settings?.output_type;
  if (!raw) return result;

  const types: string[] = Array.isArray(raw) ? raw : [raw];
  const placeholders: NodeToolOutput[] = [];

  for (const t of types) {
    const toolName = OUTPUT_TYPE_TO_TOOL[t];
    if (toolName) {
      placeholders.push({ tool_name: toolName, type: t, data: {} });
    }
  }

  if (placeholders.length > 0) {
    result.outputs = placeholders;
  }

  return result;
}
