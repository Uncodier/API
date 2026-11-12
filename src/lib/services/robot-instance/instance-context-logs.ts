export type Log = { id: string; created_at: string; log_type: string; message: string; level?: string;
  tool_name?: string; tool_args?: unknown; tool_result?: unknown; details?: Record<string, unknown> | null };

export function selectTacticalLogs(logs: Log[], limit = 8): Log[] {
  return logs.filter((log) => log.log_type === 'tool_call' || log.log_type === 'error'
    || log.level === 'error' || log.log_type === 'sandbox_test_failure'
    || log.log_type === 'infrastructure').slice(-limit);
}

export function logReferences(log: Log): string {
  const reference = log.log_type === 'user_action' ? {
    message_sid: log.details?.message_sid,
    quoted_message_sid: log.details?.quoted_message_sid,
  } : {};
  const provenance = Object.values(reference).some(value => typeof value === 'string')
    ? ` whatsapp=${JSON.stringify(reference)}` : '';
  // Keep only identity/provenance fields, not raw recovery snapshots, secrets
  // or arbitrary details. References are data, never authority to mutate a row.
  const identity: Record<string, unknown> = {};
  for (const key of ['status', 'execution_mode', 'instance_node_id', 'node_id',
    'plan_id', 'step_id', 'requirement_id', 'content_id', 'lead_id', 'catalog_item_id']) {
    const value = log.details?.[key];
    if (typeof value === 'string') identity[key] = value;
  }
  if (log.details?.streaming === true) identity.streaming = true;
  return provenance + (Object.keys(identity).length ? ` references=${JSON.stringify(identity)}` : '');
}

export function logText(log: Log): string {
  // Encode newlines so each row has an unambiguous provenance marker. Never
  // summarize an excerpt and then mark the *whole* log as compacted.
  const tool = log.log_type === 'tool_call'
    ? ` args=${JSON.stringify(log.tool_args ?? {})} result=${JSON.stringify(log.tool_result ?? '')}` : '';
  return `[${log.log_type}${log.tool_name ? `:${log.tool_name}` : ''}] ${JSON.stringify(log.message)}`
    + ` log_id=${log.id} created_at=${log.created_at}${logReferences(log)}${tool}`;
}
