import type { ActOptions, AIProvider, Message, Tool, ToolCall } from './types';
import { observedToolName } from '@/lib/connectors/connector-observation';
import { coerceToolArgs } from '../coerce-tool-args';
import { runBoundaryHook } from './boundary';

/** Final host-approved numeric values; legacy callers retain their existing coercion. */
function normalizeBoundaryNumbers(schema: any, value: any): any {
  if ((schema?.type === 'integer' || schema?.type === 'number') && typeof value === 'string' &&
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number) && (schema.type !== 'integer' || Number.isSafeInteger(number))) return number;
  }
  if (schema?.type === 'array' && Array.isArray(value)) {
    return value.map(item => normalizeBoundaryNumbers(schema.items, item));
  }
  if (schema?.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, normalizeBoundaryNumbers(schema.properties?.[key], item)]));
  }
  return value;
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

/** Repair the model transcript, then let the host approve final effective arguments before any effect. */
export async function prepareToolCalls(message: Message, messages: Message[], finalTools: Tool[], provider: AIProvider,
  { executionBoundary, toolOverrides, enforceSingleTurn, privateToolContext }: ActOptions) {
  if (!message.tool_calls?.length) return;
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] Received ${message.tool_calls.length} tool_call(s) from ${provider}`);

  // Parse each tool call with a lenient parser. Track which ones could
  // not be recovered so we can answer them with an error tool message
  // (and keep history valid for the next provider call).
  const toolCalls: ToolCall[] = [];
  const unparseable: Array<{ id: string; name: string; error: string }> = [];

  for (const tc of message.tool_calls) {
    const logName = privateToolContext ? 'private_tool' : observedToolName(tc.function.name);
    const logId = privateToolContext ? 'private_call' : tc.id;
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_PARSE] Parsing tool call: ${logId} - ${logName}`);
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
        if (executionBoundary) finalArgs = normalizeBoundaryNumbers(toolDef.parameters, finalArgs);

        // Re-serialize back to arguments to keep history consistent with coerced state
        const stringified = JSON.stringify(finalArgs);
        if (tc.function.arguments !== stringified) {
          tc.function.arguments = stringified;
        }
      }

      if (executionBoundary) {
        // Finalize effective arguments before the host persists/approves
        // the model message. No later override may change this intent.
        if (tc.function.name === 'tools' && finalArgs.action === 'call') {
          const overrides = toolOverrides?.[finalArgs.name];
          if (overrides) {
            await runBoundaryHook(async () => {
              const innerArgs = typeof finalArgs.args === 'string' ? JSON.parse(finalArgs.args) : (finalArgs.args || {});
              finalArgs.args = JSON.stringify({ ...innerArgs, ...overrides });
            });
          }
        }
        tc.function.arguments = JSON.stringify(finalArgs);
        finalArgs = JSON.parse(tc.function.arguments);
      }

      toolCalls.push({
        toolCallId: tc.id,
        toolName: tc.function.name,
        args: finalArgs,
      });
    } else {
      console.error(
        `₍ᐢ•(ܫ)•ᐢ₎ [TOOL_PARSE] ❌ Unrecoverable arguments for ${logName} (${logId})`
      );
      unparseable.push({
        id: tc.id,
        name: tc.function.name,
        error: parsed.error || 'invalid JSON',
      });
      if (executionBoundary) {
        toolCalls.push({ toolCallId: tc.id, toolName: tc.function.name, args: JSON.parse(parsed.sanitized) });
      }
    }
  }

  if (executionBoundary) await runBoundaryHook(() => executionBoundary.onModelMessage(message));

  if (unparseable.length > 0 && !executionBoundary) {
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
    if (toolCalls.length === 0 && !enforceSingleTurn && !executionBoundary) {
      console.warn(
        `₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] All ${unparseable.length} tool call(s) had invalid arguments; continuing to next iteration after sanitizing history.`
      );
      return;
    }
  }

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ✅ Successfully parsed ${toolCalls.length} tool call(s)${unparseable.length > 0 ? ` (${unparseable.length} unparseable, answered with error)` : ''}`);
  return { toolCalls, unparseable };
}
