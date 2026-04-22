/**
 * Sanitize chat messages before sending them to Gemini's OpenAI-compatible
 * endpoint.
 *
 * Gemini's `v1beta/openai/` layer is stricter than OpenAI proper and 400s
 * (with no body) on two patterns that show up *after* the first tool turn:
 *
 *   1. Assistant message with `tool_calls` whose `content` is `null` or
 *      `undefined`. Gemini wants an empty string instead.
 *   2. Tool-role messages carrying the deprecated `name` field
 *      (a leftover from the legacy `function` role). Current OpenAI Chat
 *      Completions spec dropped it; Gemini's validator rejects it.
 *
 * Mutates `messages` in place to keep the SDK's retry/fallback paths consistent
 * (mirrors how `sanitizeMessagesForAzureVisionImages` and the
 * `tool_calls.arguments` repair in `ai-agent-executor.ts` behave).
 *
 * Returns counters so callers can log when sanitization actually altered
 * anything.
 */
export function sanitizeMessagesForGemini(messages: any[]): {
  assistantContentCoerced: number;
  toolNameStripped: number;
} {
  let assistantContentCoerced = 0;
  let toolNameStripped = 0;

  if (!Array.isArray(messages)) {
    return { assistantContentCoerced, toolNameStripped };
  }

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;

    if (
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0 &&
      (m.content === null || m.content === undefined)
    ) {
      m.content = '';
      assistantContentCoerced++;
    }

    if (m.role === 'tool' && 'name' in m) {
      delete m.name;
      toolNameStripped++;
    }
  }

  return { assistantContentCoerced, toolNameStripped };
}
