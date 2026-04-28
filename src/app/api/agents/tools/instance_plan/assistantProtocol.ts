/**
 * Assistant Protocol Wrapper for Instance Plan Tool
 * Unified tool for managing instance plans (create, list, update)
 */

import { getInstancePlansCore } from '@/app/api/agents/tools/instance_plan/get/route';
import { createInstancePlanCore } from '@/app/api/agents/tools/instance_plan/create/route';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Per-field cutoffs used to slim the `list` response.
// The orchestrator and other assistants just need an overview of existing
// plans (id, title, status, step list). Returning the full instructions /
// actual_output of every prior plan on every tool call inflates the chat
// history to 150-200 KB and has triggered "400 (no body)" responses from
// Gemini's v1beta/openai compat layer. The full record is still reachable
// via the standard HTTP endpoint when a UI/worker needs it.
const PLAN_TEXT_FIELD_LIMIT = 800;
const PLAN_DESCRIPTION_LIMIT = 400;
const STEP_TEXT_FIELD_LIMIT = 500;

type StringMap = Record<string, unknown>;

function truncateTextField(
  target: StringMap,
  field: string,
  limit: number,
): void {
  const value = target[field];
  if (typeof value !== 'string') return;
  if (value.length <= limit) return;
  target[field] = value.slice(0, limit);
  target[`${field}_truncated`] = true;
  target[`${field}_full_length`] = value.length;
}

function slimStep(step: unknown): unknown {
  if (!step || typeof step !== 'object') return step;
  const src = step as StringMap;
  const slim: StringMap = {
    id: src.id,
    title: src.title,
    order: src.order,
    status: src.status,
    type: src.type,
    role: src.role,
    skill: src.skill,
    test_command: src.test_command,
    started_at: src.started_at,
    completed_at: src.completed_at,
    duration_seconds: src.duration_seconds,
    retry_count: src.retry_count,
  };
  for (const field of ['description', 'instructions', 'expected_output', 'actual_output', 'error_message']) {
    if (typeof src[field] === 'string' && (src[field] as string).length > 0) {
      slim[field] = src[field];
      truncateTextField(slim, field, STEP_TEXT_FIELD_LIMIT);
    }
  }
  if (Array.isArray(src.artifacts)) {
    slim.artifacts_count = (src.artifacts as unknown[]).length;
  }
  return slim;
}

/**
 * Build a compact overview of a plan row. Preserves every identifier and
 * status field the caller needs to decide whether to create/update a plan,
 * but truncates the large free-text fields so the JSON stays small.
 */
function slimPlan(plan: unknown): unknown {
  if (!plan || typeof plan !== 'object') return plan;
  const src = plan as StringMap;
  const slim: StringMap = {
    id: src.id,
    title: src.title,
    plan_type: src.plan_type,
    status: src.status,
    priority: src.priority,
    instance_id: src.instance_id,
    site_id: src.site_id,
    user_id: src.user_id,
    agent_id: src.agent_id,
    created_at: src.created_at,
    updated_at: src.updated_at,
  };

  if (typeof src.description === 'string') {
    slim.description = src.description;
    truncateTextField(slim, 'description', PLAN_DESCRIPTION_LIMIT);
  }
  if (typeof src.instructions === 'string') {
    slim.instructions = src.instructions;
    truncateTextField(slim, 'instructions', PLAN_TEXT_FIELD_LIMIT);
  }
  if (typeof src.expected_output === 'string') {
    slim.expected_output = src.expected_output;
    truncateTextField(slim, 'expected_output', PLAN_TEXT_FIELD_LIMIT);
  }

  if (Array.isArray(src.success_criteria)) {
    slim.success_criteria_count = (src.success_criteria as unknown[]).length;
  }
  if (Array.isArray(src.validation_rules)) {
    slim.validation_rules_count = (src.validation_rules as unknown[]).length;
  }

  if (Array.isArray(src.steps)) {
    const rawSteps = src.steps as unknown[];
    slim.steps = rawSteps.map(slimStep);
    slim.steps_count = rawSteps.length;
  }

  return slim;
}

function slimListResponse(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const envelope = raw as StringMap;
  const data = envelope.data as StringMap | undefined;
  if (!data || !Array.isArray(data.plans)) return raw;
  return {
    ...envelope,
    data: {
      ...data,
      plans: (data.plans as unknown[]).map(slimPlan),
      _slimmed: true,
      _slim_note:
        'Fields description/instructions/expected_output and steps[*] free-text are truncated per entry. Use the HTTP endpoint or fetch by id for full bodies.',
    },
  };
}

export interface InstancePlanToolParams {
  action: 'create' | 'list' | 'update' | 'execute_step';
  
  // Common/Create/Update params
  instance_id: string; // Required for create/list
  plan_id?: string; // Required for update
  title?: string;
  description?: string;
  plan_type?: 'objective' | 'task';
  instructions?: string;
  expected_output?: string;
  success_criteria?: any[];
  validation_rules?: any[];
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'paused';
  steps?: any[];
  site_id?: string;
  user_id?: string;
  agent_id?: string;
  
  // List params
  limit?: number;
  offset?: number;

  // Execute step params
  step_id?: string;
  step_output?: string;
  step_status?: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export function instancePlanTool(site_id: string, instance_id: string, user_id?: string) {
  return {
    name: 'instance_plan',
    description:
      'Manage instance plans. Plans are strict execution paths composed of steps that the system delegates to specialized sub-agents. Use action="create" to define a new plan — each step SHOULD set "skill" (preferred, any SKILL.md slug such as makinari-rol-frontend, makinari-rol-qa, makinari-obj-template-selection) and/or "role" (legacy slug such as frontend/backend/devops/content/investigate/plan/validate/report/qa/template_selection/orchestrator) so the system injects the right skill. Use action="list" to get current plans. Use action="update" to add steps or modify an existing plan. The system auto-executes pending steps as sub-agents after you finish planning.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'execute_step'],
          description: 'Action to perform on instance plans.'
        },
        instance_id: { type: 'string', description: 'Instance UUID (required for create/list if not running in instance context)' },
        plan_id: { type: 'string', description: 'Plan UUID (required for update, and execute_step)' },
        step_id: { type: 'string', description: 'Step UUID (required for execute_step)' },
        step_output: { type: 'string', description: 'Output of the executed step (required for execute_step)' },
        step_status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: 'Status of the executed step (required for execute_step)' },
        title: { type: 'string', description: 'Plan title' },
        description: { type: 'string', description: 'Plan description' },
        plan_type: { type: 'string', enum: ['objective', 'task'], description: 'Type of plan. Must be one of: objective, task. Default: objective' },
        instructions: { type: 'string', description: 'Overall instructions for the plan' },
        expected_output: { type: 'string', description: 'Overall expected output of the plan' },
        success_criteria: { type: 'array', items: { type: 'object' }, description: 'Criteria for successful completion' },
        validation_rules: { type: 'array', items: { type: 'object' }, description: 'Rules for validating the plan execution' },
        status: { 
          type: 'string', 
          enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'paused'],
          description: 'Plan status. For create, use "pending" or leave empty for default.' 
        },
          steps: { 
            type: 'array', 
            items: { 
              type: 'object', 
              properties: {
                id: { type: 'string', description: 'Unique ID for the step' },
                title: { type: 'string', description: 'Title of the step' },
                description: { type: 'string', description: 'Description of the step' },
                order: { type: 'number', description: 'Order of execution' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: 'Status of the step' },
                type: { type: 'string', description: 'Type of step (e.g., task, research, content_creation)' },
                instructions: { type: 'string', description: 'Detailed instructions for the step' },
                expected_output: { type: 'string', description: 'Expected output of the step' },
                success_criteria: { type: 'array', items: { type: 'string' }, description: 'Criteria for successful completion of this step' },
                validation_rules: { type: 'array', items: { type: 'string' }, description: 'Rules for validating this step execution' },
                actual_output: { type: 'string', description: 'Actual output after execution' },
                started_at: { type: 'string', format: 'date-time', description: 'ISO 8601 datetime when step started' },
                completed_at: { type: 'string', format: 'date-time', description: 'ISO 8601 datetime when step completed' },
                duration_seconds: { type: 'number', description: 'Duration of step execution in seconds' },
                retry_count: { type: 'number', description: 'Number of times the step was retried' },
                error_message: { type: 'string', description: 'Error message if step failed' },
                artifacts: { type: 'array', items: { type: 'object' }, description: 'Artifacts generated by the step' },
                role: { type: 'string', description: 'Optional legacy role slug for skill injection (frontend, backend, devops, content, qa, investigate, plan, validate, report, template_selection, orchestrator). Prefer setting "skill" instead — role is only used as a fallback when skill is empty.' },
                skill: { type: 'string', description: 'Preferred: explicit SKILL.md slug to inject (e.g. makinari-rol-frontend, makinari-rol-qa, makinari-obj-template-selection). Takes priority over role. One of skill or role must be set.' },
                test_command: { type: 'string', description: 'Command to run automated tests for this step (e.g. "npm run test:backend"). If omitted, defaults to the standard test command.' },
              },
              required: ['title', 'instructions'],
            },
            description: 'Array of plan steps with detailed properties.' 
          },
        site_id: { type: 'string', description: 'Site UUID' },
        user_id: { type: 'string', description: 'User UUID' },
        agent_id: { type: 'string', description: 'Agent UUID' },
        limit: { type: 'number', description: 'Limit results' },
        offset: { type: 'number', description: 'Offset results' },
      },
      required: ['action'],
    },
    execute: async (args: InstancePlanToolParams) => {
      console.log('[InstancePlanTool] Execute called with args:', args);
      const { action, ...params } = args;

      // Default instance_id if not provided but available in closure
      if (!params.instance_id && instance_id) {
        params.instance_id = instance_id;
      }

      // Prevent "default" from being passed as a UUID
      if (params.instance_id === 'default') {
        delete (params as any).instance_id;
      }
      
      // Default site_id if not provided but available in closure
      if (!params.site_id && site_id) {
        params.site_id = site_id;
      }

      // Default user_id if not provided but available in closure
      if (!params.user_id && user_id) {
        params.user_id = user_id;
      }

      if (action === 'create') {
        console.log('[InstancePlanTool] Creating instance plan with instance_id:', params.instance_id);
        if (!params.instance_id) {
             throw new Error('Missing required field: instance_id');
        }
        const body = {
          ...params,
          site_id: params.site_id || site_id,
          user_id: params.user_id || user_id,
        };
        
        return createInstancePlanCore(body);
      }

      if (action === 'execute_step') {
        console.log('[InstancePlanTool] Executing step with plan_id:', params.plan_id, 'and step_id:', params.step_id);
        if (!params.plan_id) {
          throw new Error('Missing required field for execute_step: plan_id');
        }
        if (!params.step_id) {
          throw new Error('Missing required field for execute_step: step_id');
        }
        if (!params.step_status) {
          throw new Error('Missing required field for execute_step: step_status');
        }

        try {
          const body = {
            plan_id: params.plan_id,
            site_id: params.site_id || site_id,
            instance_id: params.instance_id || instance_id,
            steps: [{
              id: params.step_id,
              actual_output: params.step_output,
              status: params.step_status,
            }],
          };
          const result = await updateInstancePlanCore(body);

          // Log the step execution
          if (params.instance_id || instance_id) {
            await supabaseAdmin.from('instance_logs').insert({
              instance_id: params.instance_id || instance_id,
              site_id: params.site_id || site_id,
              user_id: params.user_id || user_id,
              log_type: 'step_execution',
              level: 'info',
              message: `Step Execution: ${params.step_status} - ${params.step_output ? params.step_output.substring(0, 50) + '...' : 'No output'}`,
              details: {
                plan_id: params.plan_id,
                step_id: params.step_id,
                output: params.step_output,
                status: params.step_status
              }
            });
          }

          console.log('[InstancePlanTool] execute_step result:', result);
          return result;
        } catch (error: any) {
          console.error('[InstancePlanTool] Error during execute_step:', error);
          // Re-throw the error or return a structured error response
          throw new Error(`Failed to execute step: ${error.message || 'Unknown error'}`);
        }
      }

      if (action === 'update') {
        if (!params.plan_id) {
            throw new Error('Missing required field for update: plan_id');
        }
        const body = {
          ...params,
          site_id: params.site_id || site_id,
        };
        
        return updateInstancePlanCore(body);
      }

      if (action === 'list') {
        const filters = {
          ...params,
          instance_id: params.instance_id || instance_id,
        };
        const raw = await getInstancePlansCore(filters);
        return slimListResponse(raw);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
