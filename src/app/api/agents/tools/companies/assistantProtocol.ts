/**
 * Assistant Protocol Wrapper for Companies Tool
 * Unified tool for managing companies (create, list, update, delete)
 */

import { getCompaniesCore } from '@/app/api/agents/tools/companies/get/route';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface CompaniesToolParams {
  action: 'create' | 'list' | 'update' | 'delete';
  
  // Common / Create / Update params
  company_id?: string;
  name?: string;
  website?: string;
  industry?: string;
  size?: string;
  description?: string;
  phone?: string;
  email?: string;
  linkedin_url?: string;
  employees_count?: number;
  annual_revenue?: string;
  founded?: string;

  // List params
  limit?: number;
  offset?: number;
  search?: string;
}

/**
 * Creates a companies tool for OpenAI/assistant compatibility
 */
export function companiesTool() {
  return {
    name: 'companies',
    description:
      'Manage companies (e.g. vendors, partners, clients). Use action="create" to record a new company. Use action="update" to modify a company. Use action="list" to search companies. Use action="delete" to remove a company record.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'delete'],
          description: 'Action to perform on companies.'
        },
        company_id: { type: 'string', description: 'Company UUID (required for update/delete)' },
        name: { type: 'string', description: 'Company name (required for create)' },
        website: { type: 'string', description: 'Company website URL' },
        industry: { type: 'string', description: 'Company industry' },
        size: { type: 'string', description: 'Company size category (e.g. 1-10, 50-200)' },
        description: { type: 'string', description: 'Company description' },
        phone: { type: 'string', description: 'Company phone number' },
        email: { type: 'string', description: 'Company contact email' },
        linkedin_url: { type: 'string', description: 'Company LinkedIn URL' },
        employees_count: { type: 'number', description: 'Exact number of employees' },
        annual_revenue: { type: 'string', description: 'Annual revenue string' },
        founded: { type: 'string', description: 'Year founded' },
        limit: { type: 'number', description: 'Limit results' },
        offset: { type: 'number', description: 'Offset results' },
        search: { type: 'string', description: 'Text search by company name' }
      },
      required: ['action'],
    },
    execute: async (args: CompaniesToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        if (!params.name) {
           throw new Error('Missing required field for create company: name');
        }

        const data = await fetchApiTool('/api/agents/tools/companies/create', params, 'Company creation failed');
        return data;
      }

      if (action === 'update') {
        if (!params.company_id) {
          throw new Error('Missing company_id for update action');
        }
        
        const data = await fetchApiTool('/api/agents/tools/companies/update', params, 'Company update failed');
        return data;
      }

      if (action === 'delete') {
        if (!params.company_id) {
          throw new Error('Missing company_id for delete action');
        }
        
        const data = await fetchApiTool('/api/agents/tools/companies/delete', { company_id: params.company_id }, 'Company deletion failed');
        return data;
      }

      if (action === 'list') {
        return getCompaniesCore({
          company_id: params.company_id,
          search: params.search,
          limit: params.limit,
          offset: params.offset,
        });
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
