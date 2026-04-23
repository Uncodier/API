/**
 * Sanitize chat messages before sending them to Gemini's OpenAI-compatible
 * endpoint.
 *
 * Gemini's `v1beta/openai/` layer is stricter than OpenAI proper and 400s
 * (often with no response body) on patterns that show up *after* the first
 * tool turn:
 *
 *   1. Assistant message with `tool_calls` whose `content` is `null` or
 *      `undefined`. Gemini wants an empty string instead.
 *   2. Tool-role messages carrying the deprecated `name` field
 *      (a leftover from the legacy `function` role). Current OpenAI Chat
 *      Completions spec dropped it; Gemini's validator rejects it.
 *   3. Extra top-level fields that Gemini *returns* on `choice.message`
 *      (e.g. `refusal`, `annotations`, `audio`, `reasoning_content`,
 *      `reasoning`, `thoughts`, `function_call`) and then *rejects* when
 *      they are echoed back on the next request. Because we do
 *      `messages.push(message as Message)` with whatever the provider sent,
 *      these fields stick around and explode on iteration 2.
 *   4. Extra fields inside `tool_calls[]` entries (anything beyond
 *      `id`/`type`/`function: { name, arguments }`).
 *   5. Tool-role messages with `content: null/undefined` or with a non-string
 *      object/array. Gemini returns
 *      `"Invalid value for 'content': expected a string, got null."`
 *   6. Multimodal `content` parts whose `image_url.url` is empty or an
 *      unparseable data URL. Gemini returns `"Invalid base64 image_url."`
 *
 * Mutates `messages` in place to keep the SDK's retry/fallback paths consistent
 * (mirrors how `sanitizeMessagesForAzureVisionImages` and the
 * `tool_calls.arguments` repair in `ai-agent-executor.ts` behave).
 *
 * Returns counters so callers can log when sanitization actually altered
 * anything.
 */

import { Buffer } from 'node:buffer';

/** Fields OpenAI SDK may attach to assistant messages that Gemini's validator rejects. */
const ASSISTANT_EXTRA_FIELDS = [
  'refusal',
  'annotations',
  'audio',
  'reasoning_content',
  'reasoning',
  'thoughts',
  'function_call',
] as const;

/** Allowed fields on a tool_call entry. Everything else gets stripped. */
const ALLOWED_TOOL_CALL_KEYS = new Set(['id', 'type', 'function', 'index']);

/** Allowed fields on a tool_call.function entry. */
const ALLOWED_TOOL_CALL_FUNCTION_KEYS = new Set(['name', 'arguments']);

/**
 * Cheap data-URL sanity check: must start with `data:image/...;base64,` and the
 * payload must be non-empty and decode to at least a few bytes. We don't try to
 * validate the magic bytes here (Azure does that); we only drop URLs that are
 * structurally malformed or empty, which is the class Gemini 400s on.
 */
function isParseableDataImageUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (!url.startsWith('data:')) return true; // remote URL; let the provider decide
  const match = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(url);
  if (!match) return false;
  const [, mime, isBase64, payload] = match;
  if (!mime || !payload) return false;
  if (!isBase64) return true; // non-base64 data URL; we don't second-guess
  try {
    const decoded = Buffer.from(payload, 'base64');
    return decoded.length > 8;
  } catch {
    return false;
  }
}

function sanitizeContentParts(content: unknown, counters: { imagePartsStripped: number }): unknown {
  if (!Array.isArray(content)) return content;
  const cleaned: any[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      cleaned.push(part);
      continue;
    }
    if (part.type === 'image_url') {
      const url = part.image_url?.url ?? part.image_url;
      if (!isParseableDataImageUrl(url)) {
        counters.imagePartsStripped++;
        continue;
      }
    }
    cleaned.push(part);
  }
  return cleaned;
}

export function sanitizeMessagesForGemini(messages: any[]): {
  assistantContentCoerced: number;
  toolContentCoerced: number;
  toolNameStripped: number;
  assistantExtrasStripped: number;
  toolCallExtrasStripped: number;
  imagePartsStripped: number;
  systemMessagesDeduped: number;
} {
  let assistantContentCoerced = 0;
  let toolContentCoerced = 0;
  let toolNameStripped = 0;
  let assistantExtrasStripped = 0;
  let toolCallExtrasStripped = 0;
  let systemMessagesDeduped = 0;
  const imageCounter = { imagePartsStripped: 0 };

  if (!Array.isArray(messages)) {
    return {
      assistantContentCoerced,
      toolContentCoerced,
      toolNameStripped,
      assistantExtrasStripped,
      toolCallExtrasStripped,
      imagePartsStripped: imageCounter.imagePartsStripped,
      systemMessagesDeduped,
    };
  }

  // Gemini's OpenAI-compat layer 400s (no body) when the request carries more
  // than one `role: 'system'` entry. This shows up after multi-turn
  // orchestrators echo back the previous response (which already starts with
  // a system message) AND prepend a fresh one. Collapse all systems into a
  // single entry at index 0, preserving the FIRST system's content (callers
  // own the canonical prompt — see ai-agent-executor.ts where this is the
  // explicit `system` param).
  const systemIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'system') systemIndices.push(i);
  }
  if (systemIndices.length > 1) {
    // Remove all but the first, in reverse order so indices stay valid.
    for (let i = systemIndices.length - 1; i >= 1; i--) {
      messages.splice(systemIndices[i], 1);
      systemMessagesDeduped++;
    }
  }

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'assistant') {
      if (
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0 &&
        (m.content === null || m.content === undefined)
      ) {
        m.content = '';
        assistantContentCoerced++;
      }

      for (const key of ASSISTANT_EXTRA_FIELDS) {
        if (key in m) {
          delete m[key];
          assistantExtrasStripped++;
        }
      }

      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          for (const key of Object.keys(tc)) {
            if (!ALLOWED_TOOL_CALL_KEYS.has(key)) {
              delete tc[key];
              toolCallExtrasStripped++;
            }
          }
          if (tc.function && typeof tc.function === 'object') {
            for (const key of Object.keys(tc.function)) {
              if (!ALLOWED_TOOL_CALL_FUNCTION_KEYS.has(key)) {
                delete tc.function[key];
                toolCallExtrasStripped++;
              }
            }
          }
        }
      } else if (m.tool_calls === null || m.tool_calls === undefined) {
        // Drop the key entirely so the payload doesn't carry `tool_calls: null`,
        // which Gemini rejects when combined with a plain text assistant reply.
        if ('tool_calls' in m) {
          delete m.tool_calls;
        }
      }
    }

    if (m.role === 'tool') {
      if ('name' in m) {
        delete m.name;
        toolNameStripped++;
      }
      // Gemini rejects `content: null/undefined` on tool messages with
      // "Invalid value for 'content': expected a string, got null."
      if (m.content === null || m.content === undefined) {
        m.content = '';
        toolContentCoerced++;
      } else if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
        try {
          m.content = JSON.stringify(m.content);
        } catch {
          m.content = String(m.content);
        }
        toolContentCoerced++;
      }
    }

    // Multimodal parts — strip malformed image_url entries on any role.
    if (Array.isArray(m.content)) {
      m.content = sanitizeContentParts(m.content, imageCounter);
    }
  }

  return {
    assistantContentCoerced,
    toolContentCoerced,
    toolNameStripped,
    assistantExtrasStripped,
    toolCallExtrasStripped,
    imagePartsStripped: imageCounter.imagePartsStripped,
    systemMessagesDeduped,
  };
}
