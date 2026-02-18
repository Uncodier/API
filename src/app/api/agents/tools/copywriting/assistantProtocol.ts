/**
 * Assistant Protocol Wrapper for Copywriting Tool
 * Unified tool for managing copywriting templates (create, list, update, delete)
 */

import { getCopywritingsCore } from './get/route';

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface CopywritingToolParams {
  action: 'create' | 'list' | 'update' | 'delete' | 'get';
  
  // Create/Update params
  copywriting_id?: string; // Required for update/delete/get single
  title?: string; // Required for create
  copy_type?: 'email' | 'sms' | 'whatsapp' | 'web_content' | 'social_media' | 'ad_copy' | 'sales_script' | 'other'; // Required for create
  content?: string; // Required for create
  status?: 'draft' | 'review' | 'approved' | 'archived';
  target_audience?: string;
  use_case?: string;
  notes?: string;
  tags?: string[];

  // List params
  site_id?: string;
  user_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function copywritingTool(site_id: string, user_id?: string) {
  return {
    name: 'copywriting',
    description:
      'Manage copywriting templates and approved copies. Use action="create" to create new copy (requires title, copy_type, content). Use action="update" to update existing copy (requires copywriting_id). Use action="list" to get copies with filters. Use action="get" to get a single copy by id. Use action="delete" to remove a copy.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'delete', 'get'],
          description: 'Action to perform on copywriting templates.'
        },
        // Common/Create/Update fields
        copywriting_id: { type: 'string', description: 'Copywriting UUID (required for update/delete/get single)' },
        title: { type: 'string', description: 'Title of the copy (required for create)' },
        copy_type: { 
          type: 'string', 
          enum: ['email', 'sms', 'whatsapp', 'web_content', 'social_media', 'ad_copy', 'sales_script', 'other'],
          description: 'Type of copy (required for create)' 
        },
        content: { type: 'string', description: 'The actual text content of the copy (required for create)' },
        status: { 
          type: 'string', 
          enum: ['draft', 'review', 'approved', 'archived'],
          description: 'Status of the copy. Use "approved" for ready-to-use content.' 
        },
        target_audience: { type: 'string', description: 'Who this copy is intended for' },
        use_case: { type: 'string', description: 'When to use this copy' },
        notes: { type: 'string', description: 'Internal notes about this copy' },
        tags: { 
          type: 'array', 
          items: { type: 'string' }, 
          description: 'Tags for categorization' 
        },
        
        // List specific filters
        site_id: { type: 'string', description: 'Filter by site UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        search: { type: 'string', description: 'Text search in title, content, target_audience' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['action'],
    },
    execute: async (args: CopywritingToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        const body = {
          ...params,
          site_id: params.site_id || site_id,
          user_id: params.user_id || user_id,
        };
        // Check required fields for create
        if (!params.title || !params.copy_type || !params.content) {
           throw new Error('Missing required fields for create copywriting: title, copy_type, content');
        }

        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/copywriting/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || data.error || 'Create copywriting failed');
        }
        return data;
      }

      if (action === 'update') {
        if (!params.copywriting_id) {
            throw new Error('Missing required field for update copywriting: copywriting_id');
        }
        const body = {
          ...params,
          site_id: params.site_id || site_id,
        };
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/copywriting/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || data.error || 'Update copywriting failed');
        }
        return data;
      }

      if (action === 'delete') {
        if (!params.copywriting_id) {
            throw new Error('Missing required field for delete copywriting: copywriting_id');
        }
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/copywriting/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ copywriting_id: params.copywriting_id, site_id: params.site_id || site_id }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || data.error || 'Delete copywriting failed');
        }
        return data;
      }

      if (action === 'get') {
        if (!params.copywriting_id) {
            throw new Error('Missing required field for get copywriting: copywriting_id');
        }
        const result = await getCopywritingsCore({ 
          copywriting_id: params.copywriting_id,
          site_id: params.site_id || site_id 
        });
        if (result.copywritings.length === 0) {
          throw new Error(`Copywriting template not found: ${params.copywriting_id}`);
        }
        return result.copywritings[0];
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id: params.site_id || site_id,
          user_id: params.user_id || user_id,
        };
        return getCopywritingsCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
