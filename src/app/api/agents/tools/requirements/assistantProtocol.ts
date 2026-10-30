/**
 * Assistant Protocol Wrapper for Requirements Tool
 * Unified tool for managing requirements (create, list, update)
 */

import { getRequirementsCore } from './get/core';
import { createRequirementCore } from './create/core';
import { updateRequirementCore } from './update/core';
import { assertToolScopeArgs, ToolScreenAccessDenied } from '../router/screen-access';
import type { RequirementCommandSource } from '@/lib/services/requirement-command';
import type { RequirementEnvironment } from '@/lib/services/requirement-environment';

export interface RequirementsToolParams {
  action: 'create' | 'list' | 'update';
  
  // Create/Update params
  requirement_id?: string; // Required for update
  title?: string; // Required for create
  description?: string;
  instructions?: string;
  priority?: 'high' | 'medium' | 'low';
  status?: 'backlog' | 'validated' | 'in-progress' | 'on-review' | 'done' | 'canceled';
  completion_status?: 'pending' | 'completed' | 'rejected';
  type?: string;
  execution_environment?: RequirementEnvironment;
  budget?: number | null;
  cron?: string;
  cycle?: string;
  campaign_id?: string;
  metadata?: Record<string, unknown> | string;

  // List params
  site_id?: string;
  user_id?: string;
  search?: string;
  created_at_from?: string;
  created_at_to?: string;
  updated_at_from?: string;
  updated_at_to?: string;
  period?: 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month';
  date_from?: string;
  date_to?: string;
  date_column?: 'created_at' | 'updated_at';
  excluded_statuses?: string[];
  excluded_completion_statuses?: string[];
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function requirementsTool(site_id: string, user_id?: string, instanceId?: string, commandSource?: RequirementCommandSource) {
  return {
    name: 'requirements',
    description:
      'For create, explicitly choose execution_environment: cloud for documents with private Git persistence and no app, or workspace for actual code execution, browser interaction and commands. Never guess the environment from title or requirement type. The environment is immutable after creation; create a new requirement to change it. ' +
      'Manage requirements. Use action="create" to create a new requirement (requires title). Use action="update" to submit requested changes to an existing requirement (requires requirement_id). Interactive updates are authorized by the current real user message and persisted for the existing runner, even from a different session. Submit one consolidated update per requirement per user message; retries do not overwrite it. Preserve existing scope and include the new request in instructions. Do not create an execution plan in this session for another runner. Read command.diagnostic on update receipts and command_diagnostic on each list result: report the current state, reason and checked_at snapshot. A queued receipt is not execution or delivery; never promise queued work will start. Applied means the command was applied, not that execution or delivery completed. Blocked means report the blocker; unavailable means diagnosis could not be checked, not that work is eligible. None means no command diagnosis to report, not proof of execution. Never blindly resubmit a persisted command, even when retryable is true; use action="list" to inspect again without mutating work. Use action="list" for status questions; a question alone must not reopen work. Interactive updates do not accept ownership metadata, completion or cancellation; they preserve explicit pauses. For relative dates ("hoy", "esta semana", "el mes pasado") pass period or date_from/date_to as YYYY-MM-DD in the client timezone — do not invent UTC ISO bounds. Cron expressions fire in Server UTC: convert the client local hour to UTC before writing cron (e.g. 09:00 America/Mexico_City = 15:00 UTC). CRITICAL: requirement.instructions is the LIVING README of the project — it persists across ephemeral sandbox sessions. When creating a requirement, instructions MUST specify if it will be done as an "external deliverable" or "using Makinari tools".',
    parameters: {
      type: 'object',
      properties: {
        execution_environment: {
          type: 'string', enum: ['cloud', 'workspace'],
          description: 'Required for create: cloud = documents with private Git, no app; workspace = actual code/browser/command execution. Choose explicitly, never infer from title/type. Immutable after creation; update may only assert the current value.',
        },
        action: {
          type: 'string',
          enum: ['create', 'list', 'update'],
          description: 'Action to perform on requirements.'
        },
        // Common/Create/Update fields
        requirement_id: { type: 'string', description: 'Requirement UUID (required for update)' },
        title: { type: 'string', description: 'Requirement title (required for create)' },
        description: { type: 'string', description: 'Detailed description' },
        instructions: { type: 'string', description: 'The LIVING README of the project. On update, include: project overview, tech stack, architecture, folder structure, implementation status per feature, known issues, and next steps. This field persists across sandbox sessions and is the primary context for future cycles.' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority of the requirement. Valid values: high, medium, low. Default: medium' },
        status: { type: 'string', enum: ['backlog', 'validated', 'in-progress', 'on-review', 'done', 'canceled'], description: 'Status of the requirement. Valid values: backlog, validated, in-progress, on-review, done, canceled. Default: backlog' },
        completion_status: { type: 'string', enum: ['pending', 'completed', 'rejected'], description: 'Completion status of the requirement. Valid values: pending, completed, rejected.' },
        type: { type: 'string', description: 'Type of requirement (e.g., content, design, task, develop, analytics, etc.). Default: task' },
        budget: { type: ['number', 'null'], description: 'Nonnegative budget amount. For update only, null removes the budget cap, and must be used only when the user explicitly requests removing the cap. Omit to preserve the existing budget.' },
        cron: { type: 'string', description: 'Valid Cron expression evaluated in Server UTC (Vercel), e.g. "0 15 * * *" for 09:00 America/Mexico_City. Convert the client local hour to UTC before writing. Only set this if the user explicitly asks for periodic, recurring, or continuous updates.' },
        cycle: { type: 'string', description: 'Specify the source of the work cycle. Set this to ensure an entire development cycle is performed for the requirement (can be null or a new numeric or text value)' },
        campaign_id: { type: 'string', description: 'Campaign UUID to link requirement' },
        metadata: { type: 'object', description: 'Additional metadata (json object). metadata.git is workspace-only; cloud document Git persistence is host-managed. Cannot override execution_environment.' },
        
        // List specific filters
        site_id: { type: 'string', description: 'Filter by site UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        search: { type: 'string', description: 'Text search in title/description' },
        created_at_from: { type: 'string', description: 'Created on or after. ISO 8601, or YYYY-MM-DD interpreted in the client timezone.' },
        created_at_to: { type: 'string', description: 'Created on or before. ISO 8601, or YYYY-MM-DD interpreted in the client timezone.' },
        updated_at_from: { type: 'string', description: 'Updated on or after. ISO 8601, or YYYY-MM-DD interpreted in the client timezone.' },
        updated_at_to: { type: 'string', description: 'Updated on or before. ISO 8601, or YYYY-MM-DD interpreted in the client timezone.' },
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'],
          description: 'Client-timezone relative range for list. Prefer this over hand-written ISO filters.',
        },
        date_from: { type: 'string', description: 'Inclusive local calendar start (YYYY-MM-DD) for list. Overrides period when set.' },
        date_to: { type: 'string', description: 'Inclusive local calendar end (YYYY-MM-DD) for list. Defaults to date_from.' },
        date_column: { type: 'string', enum: ['created_at', 'updated_at'], description: 'Column for period/date_from. Default: created_at.' },
        excluded_statuses: { type: 'array', items: { type: 'string' }, description: 'Exclude requirements with these statuses' },
        excluded_completion_statuses: { type: 'array', items: { type: 'string' }, description: 'Exclude requirements with these completion statuses' },
        sort_by: { type: 'string', description: 'Field to sort by' },
        sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['action'],
    },
    execute: async (args: RequirementsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        // The creator is also the scheduler's execution actor. Never fall back
        // to the site owner or accept a model-supplied actor for delegated work.
        if (!user_id) throw new ToolScreenAccessDenied();
        assertToolScopeArgs('requirements', args, { siteId: site_id, userId: user_id });
        params.site_id = site_id;
        params.user_id = user_id;
      }

      // Default site_id if not provided but available in closure
      if (!params.site_id && site_id) {
        params.site_id = site_id;
      }
      
      // Default user_id if not provided but available in closure
      if (!params.user_id && user_id) {
        params.user_id = user_id;
      }

      // Parse metadata if it is a string
      if (params.metadata && typeof params.metadata === 'string') {
        try {
          params.metadata = JSON.parse(params.metadata);
        } catch (e) {
          throw new Error('Invalid metadata format. Must be a valid JSON string or object.');
        }
      }

      if (action === 'create') {
        // Check required fields for create
        if (!params.title) {
           throw new Error('Missing required fields for create requirement: title');
        }
        if (!params.site_id) {
          throw new Error('Missing required fields for create requirement: site_id');
        }
        if (params.execution_environment === undefined) {
          throw new Error('Missing required field for create requirement: execution_environment (cloud for documents with private Git and no app; workspace for code/browser/commands)');
        }

        // Execution identity comes from the server closure, never model metadata.
        return createRequirementCore(params, instanceId);
      }

      if (action === 'update') {
        assertToolScopeArgs('requirements', args, { siteId: site_id, userId: user_id });
        if (commandSource && (commandSource.siteId !== site_id || commandSource.userId !== user_id ||
            commandSource.instanceId !== instanceId || (args.user_id != null && args.user_id !== user_id))) {
          throw new ToolScreenAccessDenied();
        }
        if (!params.requirement_id) {
            throw new Error('Missing required field for update requirement: requirement_id');
        }
        if (!params.site_id) {
          throw new Error('Missing required fields for update requirement: site_id');
        }
        return updateRequirementCore(params, commandSource);
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id: params.site_id || site_id,
          user_id: params.user_id || user_id,
        };
        return getRequirementsCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
