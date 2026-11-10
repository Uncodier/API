import { usableSupportContent } from './response-content';

type RecordValue = Record<string, any>;
const object = (value: unknown): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function responseRow(row: unknown): row is RecordValue {
  return object(row)
    && (row.type === undefined || row.type === 'message' || row.type === 'text')
    && !('tool' in row) && !('tool_call_id' in row) && !('tool_calls' in row)
    && !('function_call' in row)
    && (row.role === undefined || row.role === 'assistant');
}

export function extractSupportResults(executedCommand: any) {
  const rows: unknown[] = Array.isArray(executedCommand?.results) ? executedCommand.results : [];
  const responses = rows.filter(responseRow);
  const conversations = rows.filter((row): row is RecordValue => object(row)
    && (row.type === undefined || row.type === 'conversation')
    && !('tool' in row) && !('tool_call_id' in row));
  const conversationTargets = conversations.flatMap(row => [
    row.conversation, row.content?.conversation,
    ...(row.type === 'conversation' ? [row.content] : []),
  ]).filter(object);
  const conversationTitle = conversationTargets.find(target =>
    typeof target.title === 'string' && target.title.trim())?.title as string | undefined;

  // Keep flags attached to the selected message, not another result.
  const candidates: { value: unknown; flags: RecordValue[] }[] = [];
  const add = (value: unknown, ...flags: unknown[]) => {
    candidates.push({ value, flags: flags.filter(object) });
  };
  for (const row of responses) add(row.message?.content, row, row.message);
  for (const row of responses) {
    // Explicit wrappers and supported legacy shapes only. Never stringify.
    if (row.conversation && row.type === undefined) continue;
    add(row.content, row);
    add(row.content?.message?.content, row, row.content, row.content?.message);
    add(row.content?.content, row, row.content);
    if (row.type === undefined) add(row.text, row);
  }
  for (const row of rows) if (typeof row === 'string') add(row);
  const selected = candidates.find(candidate => usableSupportContent(candidate.value));
  const assistantMessage = usableSupportContent(selected?.value);
  // Only the selected response may choose delivery format. Never borrow from
  // tools, discarded candidates, or conversation flags. Innermost target wins.
  const responseFormat = [...(selected?.flags || [])].reverse()
    .find(source => Object.prototype.hasOwnProperty.call(source, 'response_format'))?.response_format;
  const sources = [...(selected?.flags || []), ...conversationTargets];
  // Any explicit suppression wins over a false conversation flag.
  const flag = (key: string): boolean | undefined => {
    const values = sources.map(source => source[key]);
    return values.includes(true) ? true : values.includes(false) ? false : undefined;
  };
  return { assistantMessage, conversationTitle,
    ...(responseFormat === 'text' || responseFormat === 'audio' ? { responseFormat } : {}),
    isRobot: flag('is_robot'), isTransactionalMessage: flag('is_transactional_message'),
    isErratic: flag('is_erratic') };
}
