import { connectorObservation, observedToolName } from './connector-observation';

export type LogContent = { tool_name?: string | null; tool_args?: unknown; tool_result?: unknown; message?: string | null; details?: unknown };

/** Readers of historical rows must not hand raw connector DTOs or the server's
 * recovery checkpoint back to an agent. This is never used to resume execution. */
export function sharedInstanceLog<T extends LogContent>(row: T) {
  const name = row.tool_name;
  const observation = connectorObservation(name, row.tool_args, row.tool_result);
  if (observation && typeof name === 'string') {
    const result = row.tool_result as { success?: unknown; operation_outcome?: unknown } | undefined;
    const outcome = result?.operation_outcome;
    return { ...row, tool_name: observedToolName(name),
      message: `${observedToolName(name)}: ${observation.action} (${observation.tool_origin ?? 'private tools'})`,
      tool_args: observation, tool_result: {
        ...(typeof result?.success === 'boolean' && { success: result.success }),
        ...((outcome === 'passed' || outcome === 'failed' || outcome === 'unknown') && { operation_outcome: outcome }),
      }, details: null, screenshot_base64: null, artifacts: null };
  }
  if (row.details && typeof row.details === 'object' && Object.hasOwn(row.details, 'assistant_recovery')) {
    const { assistant_recovery: _checkpoint, ...details } = row.details as Record<string, unknown>;
    return { ...row, details };
  }
  return row;
}
