import { serializedBytes } from '@/lib/harness/engine-results';
import { redactData } from '@/lib/harness/security';
import type { Message } from '@/lib/harness/types';
import { requirementOperationResult } from './requirement-operation';

export const HISTORY_RECEIPT_BUDGET = 350000;

type HistoryMessage = {
  index: number;
  role: Message['role'];
  reference: { source: 'messages'; index: number };
  content?: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string }[];
  omitted?: 'history_result';
  metadataOmitted?: true;
  truncated?: boolean;
  contentOffset?: number;
  totalChars?: number;
  nextContentOffset?: number | null;
};

type HistoryResult = { ok: true; output: {
  offset: number; total: number; messages: HistoryMessage[]; nextOffset: number | null;
} };

// Offsets use UTF-16 units like artifact reads, but never split a surrogate pair.
function characterBoundary(text: string, offset: number): number {
  return offset > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(offset)) &&
    /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)) ? offset - 1 : offset;
}

function legacyHistoryReceipt(message: Message): boolean {
  // An imported receipt may lack its call. Inspect only its outer envelope;
  // never recursively decode the embedded messages/content of an old page.
  try {
    const output = JSON.parse(message.content)?.output;
    // The retired engine encoded the page as a string and had no nextOffset.
    const page = typeof output === 'string' ? JSON.parse(output) : output;
    return !!page && Number.isSafeInteger(page.offset) && Number.isSafeInteger(page.total) &&
      Array.isArray(page.messages) && (page.nextOffset == null || Number.isSafeInteger(page.nextOffset));
  } catch { return false; }
}

/** A read-only projection, not a replacement for the provider's canonical transcript. */
export function readRequirementHistory(input: {
  messages: readonly Message[]; offset: number; limit: number; contentOffset?: number;
  callId: string; redact: (text: string) => string;
}): HistoryResult {
  const names = new Map<string, string>();
  for (const message of input.messages) for (const call of message.toolCalls || []) names.set(call.id, call.name);
  const messages: HistoryMessage[] = [];
  const result = (entries: HistoryMessage[]): HistoryResult => ({ ok: true, output: {
    offset: input.offset, total: input.messages.length, messages: entries,
    nextOffset: input.offset + entries.length < input.messages.length ? input.offset + entries.length : null,
  } });
  // Measure the same redaction, normalization and nested JSON envelope that the
  // boundary will persist, not just the unescaped array or its character count.
  const fits = (entries: HistoryMessage[]) => serializedBytes({ role: 'tool', toolCallId: input.callId,
    content: JSON.stringify(requirementOperationResult(redactData(result(entries), input.redact))),
  }) <= HISTORY_RECEIPT_BUDGET;

  for (let index = input.offset; index < Math.min(input.messages.length, input.offset + input.limit); index++) {
    const message = input.messages[index];
    const reference = { source: 'messages' as const, index };
    const identity: HistoryMessage = { index, role: message.role, reference };
    // No reasoningDetails or raw arguments (which can contain thought_process).
    let metadata: HistoryMessage = redactData({ ...identity,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolCalls?.length ? { toolCalls: message.toolCalls.map(({ id, name }) => ({ id, name })) } : {}),
    }, input.redact);
    const name = message.toolCallId ? names.get(message.toolCallId) : undefined;
    if (message.role === 'tool' && (name === 'read_session_history' || (!name && legacyHistoryReceipt(message)))) {
      // Even explicit content reads cannot re-embed a history receipt. Its
      // underlying source messages remain readable at their canonical indices.
      let entry: HistoryMessage = { ...metadata, omitted: 'history_result' };
      if (!fits([...messages, entry])) {
        if (messages.length) break;
        entry = { ...identity, omitted: 'history_result', metadataOmitted: true };
      }
      messages.push(entry);
      continue;
    }

    // Redact the WHOLE string before slicing, including secrets crossing a page
    // boundary. Content offsets refer to this redacted view, never the raw text.
    const text = input.redact(message.content);
    const start = characterBoundary(text, Math.min(input.contentOffset ?? 0, text.length));
    const entry = (end: number): HistoryMessage => ({ ...metadata, content: text.slice(start, end),
      ...(start > 0 || end < text.length || input.contentOffset !== undefined ? {
        truncated: start > 0 || end < text.length, contentOffset: start, totalChars: text.length,
        nextContentOffset: end < text.length ? end : null,
      } : {}),
    });
    if (fits([...messages, entry(text.length)])) {
      messages.push(entry(text.length));
      continue;
    }
    if (messages.length) break;

    // An oversized first item must still consume one message index. Drop only
    // projection metadata if necessary; never modify the source message/ledger.
    const minimumEnd = start < text.length ? start + (text.codePointAt(start)! > 0xffff ? 2 : 1) : start;
    // Leave room for at least one complete code point, not just empty content;
    // otherwise large metadata alone could stall the optional content cursor.
    if (!fits([entry(minimumEnd)])) metadata = { ...identity, metadataOmitted: true };
    let low = 0;
    let high = text.length - start;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits([entry(characterBoundary(text, start + mid))])) low = mid;
      else high = mid - 1;
    }
    messages.push(entry(characterBoundary(text, start + low)));
    break;
  }
  return result(messages);
}