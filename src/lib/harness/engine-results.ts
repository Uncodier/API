import type { ArtifactStore, Message, ToolCall, ToolResult } from './types';
import { redactData } from './security';

export const RESULT_MAX_BYTES = 1024 * 1024;
export const RECEIPT_MAX_BYTES = 12000;
export const SNAPSHOT_MAX_BYTES = 3900000;

export function serializedBytes(value: unknown): number {
  // Postgres jsonb::text adds spaces after separators; reserve conservatively for that too.
  const text = JSON.stringify(value);
  return Buffer.byteLength(text) + (text.match(/[,:]/g)?.length || 0);
}

export async function persistResult(input: { artifacts: ArtifactStore; sessionId: string; siteId: string;
  owner: string; call: ToolCall; result: ToolResult; redact: (text: string) => string }): Promise<Message> {
  const text = JSON.stringify(redactData(input.result, input.redact));
  // Artifact store has already reserved the maximum supported result before dispatch.
  const artifact = await input.artifacts.put(input.sessionId, input.siteId, input.owner, input.call.id, text);
  const message: Message = { role: 'tool', toolCallId: input.call.id, content: text };
  if (serializedBytes(message) <= RECEIPT_MAX_BYTES) return message;
  let prefix = text.slice(0, 6000);
  let suffix = text.slice(-1000);
  do {
    message.content = JSON.stringify({ ok: input.result.ok, artifact, excerpt: prefix, tail: suffix,
      truncated: true,
      note: 'Full redacted result preserved. Use read_result_artifact with artifact.id and character offsets.' });
    if (serializedBytes(message) <= RECEIPT_MAX_BYTES) return message;
    prefix = prefix.slice(0, Math.floor(prefix.length / 2));
    suffix = suffix.slice(Math.floor(suffix.length / 2));
  } while (prefix.length || suffix.length);
  return message;
}