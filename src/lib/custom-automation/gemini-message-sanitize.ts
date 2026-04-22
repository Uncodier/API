/**
 * Sanitize chat messages before sending them to Gemini's OpenAI-compatible
 * endpoint.
 *
 * Gemini's `v1beta/openai/` layer is stricter than OpenAI proper and 400s
 * (with no body) on patterns that show up *after* the first tool turn:
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
 *
 * Mutates `messages` in place to keep the SDK's retry/fallback paths consistent
 * (mirrors how `sanitizeMessagesForAzureVisionImages` and the
 * `tool_calls.arguments` repair in `ai-agent-executor.ts` behave).
 *
 * Returns counters so callers can log when sanitization actually altered
 * anything.
 */

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

export function sanitizeMessagesForGemini(messages: any[]): {
  assistantContentCoerced: number;
  toolNameStripped: number;
  assistantExtrasStripped: number;
  toolCallExtrasStripped: number;
} {
  let assistantContentCoerced = 0;
  let toolNameStripped = 0;
  let assistantExtrasStripped = 0;
  let toolCallExtrasStripped = 0;

  if (!Array.isArray(messages)) {
    return {
      assistantContentCoerced,
      toolNameStripped,
      assistantExtrasStripped,
      toolCallExtrasStripped,
    };
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

    if (m.role === 'tool' && 'name' in m) {
      delete m.name;
      toolNameStripped++;
    }
  }

  return {
    assistantContentCoerced,
    toolNameStripped,
    assistantExtrasStripped,
    toolCallExtrasStripped,
  };
}
