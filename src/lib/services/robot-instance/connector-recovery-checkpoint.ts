import { connectorObservation, observedToolName } from '@/lib/connectors/connector-observation';
import { isRecord, type AssistantRecoverySnapshot } from './assistant-recovery-schema';
import { ownerConnectorTranscript } from './owner-connector-transcript';

/** Project only a detached, validated checkpoint copy. The live model still receives
 * its exact references/receipts. A respawn is not authorized to replay private calls. */
export function protectConnectorCheckpoint(checkpoint: Pick<AssistantRecoverySnapshot, 'messages'>, privateAsk: boolean): void {
  const owner = privateAsk ? ownerConnectorTranscript(checkpoint.messages) : undefined;
  if (owner) {
    checkpoint.messages = [...checkpoint.messages.slice(0, owner.start), {
      role: 'assistant', content: 'The owner-only connector context was not saved here. Do not replay completed connector calls or infer their contents.',
    }];
  }
  // The host rebuilds its system prompt on every resume. Do not duplicate its
  // pinned-account instruction or decorated schema on a user-visible log row.
  if (privateAsk) checkpoint.messages = checkpoint.messages.filter(m => !isRecord(m) || m.role !== 'system');
  const { messages } = checkpoint;
  const results = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (isRecord(message) && message.role === 'tool' && typeof message.tool_call_id === 'string') {
      results.set(message.tool_call_id, message);
    }
  }
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== 'string') continue;
      const result = typeof call.id === 'string' ? results.get(call.id) : undefined;
      const observation = connectorObservation(call.function.name, call.function.arguments, result?.content);
      if (!observation) continue;
      call.function.name = observedToolName(call.function.name);
      call.function.arguments = JSON.stringify(observation);
      if (result) {
        if (typeof result.name === 'string') result.name = observedToolName(result.name);
        result.content = 'Private tool details omitted from recovery. This is not an execution receipt. Do not replay this call.';
      }
    }
  }
}
