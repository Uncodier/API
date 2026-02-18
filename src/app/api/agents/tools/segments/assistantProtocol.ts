/**
 * Assistant Protocol Wrapper for Segments Tool
 * Unified tool for managing segments (create, list, update)
 */

import { getSegmentCore } from './get/route';

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface SegmentsToolParams {
  action: 'create' | 'list' | 'update';
  
  // Common/Create/Update params
  segment_id?: string;
  name?: string;
  description?: string;
  audience?: string;
  size?: number;
  estimated_value?: number;
  language?: string;
  is_active?: boolean;
  attributes?: Record<string, unknown>;
  analysis?: any[];
  
  // List params
  site_id?: string;
  user_id?: string;
  limit?: number;
  offset?: number;
}

export function segmentsTool(site_id: string, user_id?: string) {
  return {
    name: 'segments',
    description:
      'Manage audience segments. Use action="create" to create a new segment (requires name). Use action="update" to update an existing segment (requires segment_id). Use action="list" to get segments with filters.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update'],
          description: 'Action to perform on segments.'
        },
        segment_id: { type: 'string', description: 'Segment UUID (required for update)' },
        name: { type: 'string', description: 'Segment name' },
        description: { type: 'string', description: 'Description' },
        audience: { type: 'string', description: 'Target audience category (e.g. professional, tech)' },
        size: { type: 'number', description: 'Estimated audience size' },
        estimated_value: { type: 'number', description: 'Estimated value' },
        language: { type: 'string', description: 'Language code (e.g. en)' },
        is_active: { type: 'boolean', description: 'Is segment active?' },
        attributes: { type: 'object', description: 'Additional attributes' },
        
        // List filters
        site_id: { type: 'string', description: 'Filter by site UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        limit: { type: 'number', description: 'Max results' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['action'],
    },
    execute: async (args: SegmentsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        const body = {
          ...params,
          site_id,
          user_id,
        };
        if (!params.name) {
           throw new Error('Missing required fields for create segment: name');
        }

        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/segments/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || data.error || 'Create segment failed');
        }
        return data;
      }

      if (action === 'update') {
        if (!params.segment_id) {
            throw new Error('Missing required field for update segment: segment_id');
        }
        const body = {
          ...params,
          site_id,
        };
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/segments/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || data.error || 'Update segment failed');
        }
        return data;
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id: params.site_id || site_id,
          user_id: params.user_id || user_id,
        };
        // @ts-ignore
        return getSegmentCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
