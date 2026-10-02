import { redactRuntimeSecrets } from '@/app/api/cron/shared/runtime-log-context';

/** Private provenance, never tool arguments, model output, or lookup authority. */
export type ToolExecutionContext = {
  version: 1;
  site_id: string;
  intent?: string;
  background?: string;
  source: {
    tool?: string;
    instance_id?: string;
    node_id?: string;
    conversation_id?: string;
    message_id?: string;
    content_id?: string;
    audience_id?: string;
  };
};

export const TOOL_CONTEXT_INTENT_MAX_CHARS = 2_000;
export const TOOL_CONTEXT_BACKGROUND_MAX_CHARS = 4_000;
export const TOOL_CONTEXT_MAX_JSON_BYTES = 8_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_IDS = [
  'instance_id', 'node_id', 'conversation_id', 'message_id', 'content_id', 'audience_id',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Accept text only. Redact the whole input BEFORE applying any length budget. */
export function sanitizeToolContextText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(maxChars) || maxChars < 1) return undefined;
  // Email redaction would otherwise consume the @ and leave URL credentials visible.
  const withoutUserinfo = value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1')
    .replace(/([?&](?:x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential)|api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|credential)=)[^&#\s"'<>]+/gi, '$1[REDACTED]');
  const text = redactRuntimeSecrets(withoutUserinfo)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, Math.floor(maxChars))
    .trimEnd();
  return text || undefined;
}

/**
 * Read only the versioned whitelist, bound to the caller's independently verified
 * tenant. Source IDs are provenance, not permission to fetch any referenced row.
 * Unknown fields (including history, prompts and overrides) are never serialized.
 */
export function readToolExecutionContext(value: unknown, siteId: string): ToolExecutionContext | undefined {
  if (!isRecord(value) || value.version !== 1 || value.site_id !== siteId
    || typeof siteId !== 'string' || !UUID.test(siteId) || !isRecord(value.source)) return undefined;

  const source: ToolExecutionContext['source'] = {};
  if (typeof value.source.tool === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(value.source.tool)) {
    source.tool = value.source.tool;
  }
  for (const key of SOURCE_IDS) {
    const id = value.source[key];
    if (typeof id === 'string' && UUID.test(id)) source[key] = id;
  }
  const context: ToolExecutionContext = { version: 1, site_id: siteId, source };
  const intent = sanitizeToolContextText(value.intent, TOOL_CONTEXT_INTENT_MAX_CHARS);
  const background = sanitizeToolContextText(value.background, TOOL_CONTEXT_BACKGROUND_MAX_CHARS);
  if (intent) context.intent = intent;
  if (background) context.background = background;

  // JSON escaping and multi-byte text also count. Keep intent in preference to
  // background; shrink only text that has already passed through redaction.
  for (const key of ['background', 'intent'] as const) {
    while (context[key] && Buffer.byteLength(JSON.stringify(context), 'utf8') > TOOL_CONTEXT_MAX_JSON_BYTES) {
      context[key] = context[key]!.slice(0, -128).trimEnd();
      if (!context[key]) delete context[key];
    }
  }
  return context;
}

/** Build from explicitly selected text and references, never a raw assistant context. */
export function buildToolExecutionContext(input: {
  site_id: string;
  intent?: unknown;
  background?: unknown;
  source?: unknown;
}): ToolExecutionContext | undefined {
  return readToolExecutionContext({
    version: 1,
    site_id: input.site_id,
    intent: input.intent,
    background: input.background,
    source: input.source ?? {},
  }, input.site_id);
}