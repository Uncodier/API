export const WF_NODE_TYPES = ['wf-trigger', 'wf-step', 'wf-condition'] as const;

export type WorkflowTriggerKind = 'cron' | 'db_event' | 'webhook' | 'manual';

export interface WorkflowTriggerConfig {
  kind: WorkflowTriggerKind;
  cron?: string;
  table?: string;
  op?: 'insert' | 'update' | 'delete';
  filter?: Record<string, unknown>;
}

export interface WorkflowStepSettings {
  skill?: string;
  requires_sandbox?: boolean;
  requires_browser?: boolean;
  browser_allowed_domains?: string[];
  browser_secret_names?: string[];
  mcp_actions?: Array<{ tool: string; action?: string; hint?: string }>;
  expected_output?: string;
  success_criteria?: unknown[];
  validation_rules?: unknown[];
  max_retries?: number;
  recovery_plan?: string;
}

export interface WorkflowGraphNode {
  id: string;
  instance_id: string;
  parent_node_id: string | null;
  type: string;
  status?: string;
  prompt?: { text?: string } | Record<string, unknown>;
  settings?: Record<string, unknown>;
  site_id: string;
  user_id?: string;
}

export interface MaterializeRunInput {
  instance_id: string;
  trigger_payload?: Record<string, unknown>;
  dry_run?: boolean;
  trigger_id?: string | null;
  idempotency_key?: string | null;
  from_step_id?: string;
}

export interface MaterializeRunResult {
  template_plan_id: string;
  run_plan_id: string;
  workflow_run_id: string;
  dry_run: boolean;
  steps: unknown[];
  resume_existing_run?: boolean;
}

export const DB_EVENT_TABLES = [
  'leads',
  'deals',
  'conversations',
  'tasks',
  'quotations',
  'reservations',
  'content',
  'sales',
  'records',
] as const;
