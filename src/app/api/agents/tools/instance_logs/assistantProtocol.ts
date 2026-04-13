import { createInstanceLogCore, listInstanceLogsCore, type CreateInstanceLogParams } from './route';

function parseDetailsField(details: CreateInstanceLogParams['details']) {
  if (details === undefined || details === null) return details;
  if (typeof details === 'string') {
    try {
      return JSON.parse(details) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return details;
}

export function instanceLogsTool(site_id: string, user_id?: string, instance_id?: string) {
  return {
    name: 'instance_logs',
    description: 'Logs important events or retrieves the history of logs for a specific instance/site. Use action="create" to save a new log entry, or action="list" to retrieve logs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list'], description: 'Action to perform. Default is "create"' },
        instance_id: { type: 'string', description: 'ID of the related instance (optional). Defaults to the current instance.' },
        user_id: { type: 'string', description: 'ID of the related user (optional). Defaults to the current user.' },
        log_type: { type: 'string', description: 'Type of log (e.g. system, user_action, agent_action, tool_call) (required for create)' },
        level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'Severity level (e.g. info, warn, error) (required for create)' },
        message: { type: 'string', description: 'Message or detail of the log (required for create)' },
        details: { type: 'string', description: 'Additional context or metadata in JSON format (optional, as string). Pass a `usage` object (e.g. {"usage": {"prompt_tokens": 10, "completion_tokens": 5}}) to deduct credits.' },
        tool_name: { type: 'string', description: 'For tool_call logs: registered tool name (e.g. generate_image). Stored in instance_logs.tool_name.' },
        tool_call_id: { type: 'string', description: 'Optional provider tool call id.' },
        tool_args: { type: 'string', description: 'Tool arguments as JSON string (optional).' },
        tool_result: { type: 'string', description: 'Tool result payload as JSON string (optional).' },
        step_id: { type: 'string', description: 'Optional plan step identifier (e.g. step_1).' },
        parent_log_id: { type: 'string', description: 'Optional UUID of parent log row.' },
        agent_id: { type: 'string', description: 'Optional agent UUID.' },
        command_id: { type: 'string', description: 'Optional command UUID.' },
        is_error: { type: 'boolean', description: 'Whether this log represents an error outcome.' },
        duration_ms: { type: 'number', description: 'Optional duration in milliseconds.' },
        limit: { type: 'number', description: 'Maximum number of logs to return (optional, default 50)' },
        offset: { type: 'number', description: 'Offset for pagination (optional, default 0)' }
      }
    },
    execute: async (args: {
      action?: 'create' | 'list';
      instance_id?: string;
      user_id?: string;
      log_type?: string;
      level?: string;
      message?: string;
      details?: string;
      tool_name?: string;
      tool_call_id?: string;
      tool_args?: string;
      tool_result?: string;
      step_id?: string;
      parent_log_id?: string;
      agent_id?: string;
      command_id?: string;
      is_error?: boolean;
      duration_ms?: number;
      limit?: number;
      offset?: number;
    }) => {
      const action = args.action || 'create';
      const targetInstanceId = args.instance_id || instance_id;
      const targetUserId = args.user_id || user_id;
      
      try {
        if (action === 'create') {
          if (!args.log_type || !args.level || !args.message) {
            throw new Error('log_type, level, and message are required to create an instance log');
          }
          
          const result = await createInstanceLogCore({
            site_id,
            instance_id: targetInstanceId,
            user_id: targetUserId,
            log_type: args.log_type,
            level: args.level,
            message: args.message,
            details: parseDetailsField(args.details as CreateInstanceLogParams['details']),
            tool_name: args.tool_name,
            tool_call_id: args.tool_call_id,
            tool_args: args.tool_args,
            tool_result: args.tool_result,
            step_id: args.step_id,
            parent_log_id: args.parent_log_id,
            agent_id: args.agent_id,
            command_id: args.command_id,
            is_error: args.is_error,
            duration_ms: args.duration_ms,
          });
          return result;
        } else if (action === 'list') {
          const result = await listInstanceLogsCore({
            site_id,
            instance_id: targetInstanceId,
            user_id: targetUserId,
            log_type: args.log_type,
            level: args.level,
            limit: args.limit,
            offset: args.offset
          });
          return result;
        }
        
        throw new Error(`Invalid action: ${action}`);
      } catch (error: any) {
        throw new Error(error.message || `Failed to execute instance_logs tool for action ${action}`);
      }
    }
  };
}
