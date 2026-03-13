import { createInstanceLogCore, listInstanceLogsCore } from './route';

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
        log_type: { type: 'string', description: 'Type of log (e.g. system, user_action, agent_action) (required for create)' },
        level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'Severity level (e.g. info, warn, error) (required for create)' },
        message: { type: 'string', description: 'Message or detail of the log (required for create)' },
        details: { type: 'object', description: 'Additional context or metadata in JSON format (optional)' },
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
      details?: Record<string, any>;
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
            details: args.details
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
