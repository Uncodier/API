import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sanitizeRuntimeLog } from './runtime-log-context';
import {
  ACTION_LOOP_BLOCKED_ACTION_MARKER,
  buildToolActionKey,
  detectActionLoop,
} from './loop-detectors';

type StepHistoryLog = {
  log_type: string;
  message?: string | null;
  tool_name?: string | null;
  tool_args?: unknown;
  tool_result?: {
    output?: unknown;
    error?: unknown;
  } | null;
  details?: Record<string, unknown> | null;
};

export async function fetchStepLogHistoryText(instanceId: string, planId: string, stepId: string): Promise<string> {
  // Query prior actions plus correlated gate/runtime failures for this step.
  const { data: logs, error } = await supabaseAdmin
    .from('instance_logs')
    .select('id, log_type, message, tool_name, tool_args, tool_result, created_at, details')
    .eq('instance_id', instanceId)
    .in('log_type', ['agent_action', 'tool_call', 'thinking', 'infrastructure', 'sandbox_test_failure'])
    .order('created_at', { ascending: false })
    .filter('details->>plan_id', 'eq', planId)
    .filter('details->>step_id', 'eq', stepId)
    .limit(100);

  if (error) {
    console.error(`[StepHistoryBuilder] Failed to fetch logs: ${error.message}`);
    return '';
  }

  if (!logs || logs.length === 0) {
    return '';
  }

  return formatStepLogHistory(
    [...(logs as StepHistoryLog[])].reverse(),
  );
}

export function formatStepLogHistory(logs: StepHistoryLog[]): string {
  const formatted: string[] = [];
  
  formatted.push('--- PREVIOUS ACTIONS IN THIS STEP ---');
  
  // To avoid extremely long texts, we will limit the length of tool outputs
  const MAX_OUTPUT_LEN = 30000;

  for (const log of logs) {
    if (log.log_type === 'thinking' && log.message) {
      formatted.push(`[Thought Process]`);
      formatted.push(log.message.trim());
    } else if (log.log_type === 'agent_action' && log.message) {
      // Exclude empty messages or messages that are just tool calls without text
      if (log.message.trim().length > 0 && log.message !== 'Assistant step execution') {
        formatted.push(`[Assistant Text]`);
        formatted.push(log.message.trim());
      }
    } else if (log.log_type === 'tool_call' && log.tool_name) {
      formatted.push(`[Tool Call: ${log.tool_name}]`);
      if (log.tool_args) {
        try {
          formatted.push(`Arguments: ${JSON.stringify(log.tool_args)}`);
        } catch {
          formatted.push(`Arguments: (unserializable)`);
        }
      }
      if (log.tool_result) {
        let outStr = '';
        if (typeof log.tool_result.output === 'string') {
          outStr = log.tool_result.output;
        } else if (log.tool_result.output) {
          try {
            outStr = JSON.stringify(log.tool_result.output);
          } catch {
            outStr = String(log.tool_result.output);
          }
        }
        
        if (log.tool_result.error) {
          outStr = `ERROR: ${log.tool_result.error}`;
        }
        
        if (outStr.length > MAX_OUTPUT_LEN) {
          outStr = outStr.substring(0, MAX_OUTPUT_LEN) + `... [TRUNCATED, ${outStr.length - MAX_OUTPUT_LEN} more chars]`;
        }
        formatted.push(`Result: ${outStr}`);
      }
    } else if (log.log_type === 'infrastructure' || log.log_type === 'sandbox_test_failure') {
      const details = log.details && typeof log.details === 'object' ? log.details : {};
      const event = typeof details.event === 'string' ? details.event : log.log_type;
      const rawEvidence = [
        typeof details.error_excerpt === 'string' ? details.error_excerpt : '',
        typeof details.error === 'string' ? details.error : '',
        typeof details.server_log_excerpt === 'string' ? details.server_log_excerpt : '',
        Array.isArray(details.server_errors)
          ? details.server_errors
              .map((entry: unknown) =>
                entry && typeof entry === 'object' && 'line' in entry
                  ? String((entry as { line: unknown }).line)
                  : String(entry),
              )
              .join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      const evidence = sanitizeRuntimeLog(rawEvidence);
      if (evidence || log.message) {
        formatted.push(`[Runtime Evidence: ${event}]`);
        if (log.message) formatted.push(sanitizeRuntimeLog(log.message));
        if (evidence) formatted.push(evidence);
      }
    }
  }

  const recentToolCalls = logs
    .filter(
      (log): log is StepHistoryLog & { tool_name: string } =>
        log.log_type === 'tool_call' && typeof log.tool_name === 'string',
    )
    .slice(-5)
    .map((log) => ({
      name: log.tool_name,
      command: buildToolActionKey(log.tool_name, log.tool_args),
    }));
  const actionLoop = detectActionLoop(recentToolCalls);
  if (actionLoop.triggered && actionLoop.blockedAction) {
    formatted.push('[Action Loop Guard]');
    formatted.push(actionLoop.feedback || 'Change the current tool strategy.');
    formatted.push(
      `${ACTION_LOOP_BLOCKED_ACTION_MARKER}${actionLoop.blockedAction}`,
    );
  }
  
  formatted.push('--- END PREVIOUS ACTIONS ---');

  const text = formatted.join('\n');
  const maxContextChars = 12_000;
  return text.length <= maxContextChars
    ? text
    : `--- PREVIOUS ACTIONS TRUNCATED ---\n${text.slice(-maxContextChars)}`;
}
