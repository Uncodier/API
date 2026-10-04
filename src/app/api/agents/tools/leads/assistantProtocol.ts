/**
 * Assistant Protocol Wrapper for Leads Tool
 * Unified tool for managing leads (create, list, update, qualify, identify)
 */

import { getLeadCore } from './get/core';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';



export interface LeadsToolParams {
  action: 'create' | 'list' | 'update' | 'qualify' | 'identify';
  
  // Common/Create/Update/Qualify/Identify params
  lead_id?: string;
  name?: string;
  email?: string;
  phone?: string;
  position?: string;
  company?: string | Record<string, unknown>;
  notes?: string;
  status?: string;
  origin?: string;
  segment_id?: string;
  campaign_id?: string;
  assignee_id?: string;
  
  // List params
  site_id?: string;
  user_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';

  // Identify params
  visitor_id?: string;
  lead_score?: number;
  source?: string;
  contact_info?: Record<string, unknown>;
  company_info?: Record<string, unknown>;
  interest_level?: string;
  product_interest?: string;
  pages_visited?: string[] | string;
  time_spent?: number;
  visit_count?: number;
}

export function leadsTool(site_id: string, user_id?: string) {
  return {
    name: 'leads',
    description:
      'Manage leads. Use action="create" to create a new lead (requires name, email). Use action="update" to update an existing lead (requires lead_id). Use action="list" to get leads with filters. Use action="qualify" to change status (requires status). Use action="identify" to identify a visitor (requires visitor_id).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'qualify', 'identify'],
          description: 'Action to perform on leads.'
        },
        // Common/Create/Update/Qualify/Identify params
        lead_id: { type: 'string', description: 'Lead UUID' },
        name: { type: 'string', description: 'Lead full name' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
        position: { type: 'string', description: 'Job title/position' },
        company: { type: 'string', description: 'Company name' },
        notes: { type: 'string', description: 'Notes' },
        status: { type: 'string', description: 'new, contacted, qualified, converted, lost' },
        origin: { type: 'string', description: 'Lead source (e.g. website, referral)' },
        segment_id: { type: 'string', description: 'Segment UUID' },
        campaign_id: { type: 'string', description: 'Campaign UUID' },
        assignee_id: { type: 'string', description: 'Assignee user UUID' },
        
        // List specific filters
        site_id: { type: 'string', description: 'Filter by site UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        search: { type: 'string', description: 'Text search in name, email, notes' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
        sort_by: { type: 'string', description: 'Field to sort by' },
        sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order' },

        // Identify specific params
        visitor_id: { type: 'string', description: 'Visitor UUID' },
        lead_score: { type: 'number', description: 'Score 1-100' },
        source: { type: 'string', description: 'Lead source' },
        contact_info: { type: 'string', description: 'Contact details (JSON string)' },
        company_info: { type: 'string', description: 'Company details (JSON string)' },
        interest_level: { type: 'string', description: 'Interest level' },
        product_interest: { type: 'string', description: 'Product interest' },
        pages_visited: { type: 'string', description: 'Pages visited (comma-separated string)' },
        time_spent: { type: 'number', description: 'Time spent' },
        visit_count: { type: 'number', description: 'Visit count' },
      },
      required: ['action'],
    },
    execute: async (args: LeadsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        const body = {
          ...params,
          site_id,
          user_id,
        };
        if (!params.name || !params.email) {
           throw new Error('Missing required fields for create lead: name, email');
        }

        const data = await fetchApiTool('/api/agents/tools/leads/create', body, 'Create lead failed');
        return data;
      }

      if (action === 'update') {
        if (!params.lead_id) {
            throw new Error('Missing required field for update lead: lead_id');
        }
        const body = {
          ...params,
          site_id,
        };
        const data = await fetchApiTool('/api/agents/tools/leads/update', body, 'Update lead failed');
        return data;
      }

      if (action === 'qualify') {
        if (!params.status) {
            throw new Error('Missing required field for qualify lead: status');
        }
        const body = {
            ...params,
            site_id
        };
        const data = await fetchApiTool('/api/agents/tools/leads/qualify', body, 'Qualify lead failed');
        return data;
      }

      if (action === 'identify') {
        if (!params.visitor_id) {
            throw new Error('Missing required field for identify lead: visitor_id');
        }
        const body = {
          ...params,
          contact_info: params.contact_info && typeof params.contact_info === 'string' ? JSON.parse(params.contact_info) : params.contact_info,
          company_info: params.company_info && typeof params.company_info === 'string' ? JSON.parse(params.company_info) : params.company_info,
          pages_visited: params.pages_visited && typeof params.pages_visited === 'string' ? params.pages_visited.split(',').map(p => p.trim()) : params.pages_visited,
          site_id,
        };
        const data = await fetchApiTool('/api/agents/tools/leads/identify', body, 'Identify lead failed');
        return data;
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id: params.site_id || site_id,
          user_id: params.user_id || user_id,
        };
        return getLeadCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
