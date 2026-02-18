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
  campaign_id?: string;

  // List params
  site_id?: string;
  user_id?: string;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function requirementsTool(site_id: string, user_id?: string) {
  return {
    name: 'requirements',
    description:
      'Manage requirements. Use action="create" to create a new requirement (requires title). Use action="update" to update an existing requirement (requires requirement_id). Use action="list" to get requirements with filters.',
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
        instructions: { type: 'string', description: 'Implementation instructions' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority of the requirement. Valid values: high, medium, low. Default: medium' },
        status: { type: 'string', enum: ['backlog', 'validated', 'in-progress', 'on-review', 'done', 'canceled'], description: 'Status of the requirement. Valid values: backlog, validated, in-progress, on-review, done, canceled. Default: backlog' },
        completion_status: { type: 'string', enum: ['pending', 'completed', 'rejected'], description: 'Completion status of the requirement. Valid values: pending, completed, rejected.' },
        type: { type: 'string', description: 'Type of requirement (e.g., content, design, task, develop, analytics, etc.). Default: task' },
        budget: { type: 'number', description: 'Budget amount (numeric)' },
        campaign_id: { type: 'string', description: 'Campaign UUID to link requirement' },
        
        // List specific filters
        site_id: { type: 'string', description: 'Filter by site UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        search: { type: 'string', description: 'Text search in title/description' },
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
