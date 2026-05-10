import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function fetchStepLogHistoryText(instanceId: string, planId: string, stepId: string): Promise<string> {
  // Query logs for the specific step
  // We want agent_action (which has the assistant text), tool_call, and thinking logs
  const { data: logs, error } = await supabaseAdmin
    .from('instance_logs')
    .select('id, log_type, message, tool_name, tool_args, tool_result, created_at, details')
    .eq('instance_id', instanceId)
    .in('log_type', ['agent_action', 'tool_call', 'thinking'])
    .order('created_at', { ascending: true })
    .filter('details->>plan_id', 'eq', planId)
    .filter('details->>step_id', 'eq', stepId);

  if (error) {
    console.error(`[StepHistoryBuilder] Failed to fetch logs: ${error.message}`);
    return '';
  }

  if (!logs || logs.length === 0) {
    return '';
  }

  const formatted: string[] = [];
  
  formatted.push('--- PREVIOUS ACTIONS IN THIS STEP ---');
  
  // To avoid extremely long texts, we will limit the length of tool outputs
  const MAX_OUTPUT_LEN = 1500;

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
    }
  }
  
  formatted.push('--- END PREVIOUS ACTIONS ---');

  return formatted.join('\n');
}
