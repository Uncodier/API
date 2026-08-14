/**
 * Assistant Protocol Wrapper for Requirements Tool
 * Unified tool for managing requirements (create, list, update)
 */

import { getRequirementsCore } from './get/route';
import { createRequirementCore } from './create/route';
import { updateRequirementCore } from './update/route';

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
  budget?: number;
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

export function requirementsTool(site_id: string, user_id?: string) {
  return {
    name: 'requirements',
    description:
      'Manage requirements. Use action="create" to create a new requirement (requires title). Use action="update" to update an existing requirement (requires requirement_id). Use action="list" to get requirements with filters. For relative dates ("hoy", "esta semana", "el mes pasado") pass period or date_from/date_to as YYYY-MM-DD in the client timezone — do not invent UTC ISO bounds. Cron expressions fire in Server UTC: convert the client local hour to UTC before writing cron (e.g. 09:00 America/Mexico_City = 15:00 UTC). CRITICAL: requirement.instructions is the LIVING README of the project — it persists across ephemeral sandbox sessions. You MUST update instructions (action="update") at the end of every cycle with: what you found, what you built, architecture decisions, current status, and next steps. This is how future cycles know where you left off. When creating a requirement, instructions MUST specify if it will be done as an "external deliverable" or "using Makinari tools".',
    parameters: {
      type: 'object',
      properties: {
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
        budget: { type: 'number', description: 'Budget amount (numeric)' },
        cron: { type: 'string', description: 'Valid Cron expression evaluated in Server UTC (Vercel), e.g. "0 15 * * *" for 09:00 America/Mexico_City. Convert the client local hour to UTC before writing. Only set this if the user explicitly asks for periodic, recurring, or continuous updates.' },
        cycle: { type: 'string', description: 'Specify the source of the work cycle. Set this to ensure an entire development cycle is performed for the requirement (can be null or a new numeric or text value)' },
        campaign_id: { type: 'string', description: 'Campaign UUID to link requirement' },
        metadata: { type: 'object', description: 'Additional metadata (json object)' },
        
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

        return createRequirementCore(params);
      }

      if (action === 'update') {
        if (!params.requirement_id) {
            throw new Error('Missing required field for update requirement: requirement_id');
        }
        if (!params.site_id) {
          throw new Error('Missing required fields for update requirement: site_id');
        }
        return updateRequirementCore(params);
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
