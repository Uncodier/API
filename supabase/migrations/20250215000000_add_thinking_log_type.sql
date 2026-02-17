-- Add 'thinking' to instance_logs log_type CHECK constraint
-- Run this migration to enable instance_log entries for model reasoning/thinking stream

ALTER TABLE instance_logs DROP CONSTRAINT IF EXISTS instance_logs_log_type_check;

ALTER TABLE instance_logs ADD CONSTRAINT instance_logs_log_type_check
  CHECK (log_type = ANY (ARRAY[
    'system'::text,
    'user_action'::text,
    'agent_action'::text,
    'tool_call'::text,
    'tool_result'::text,
    'error'::text,
    'performance'::text,
    'thinking'::text
  ]));
