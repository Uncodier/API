/**
 * Assistant Protocol Wrapper for Categories Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface CategoriesToolParams {
  action: 'create' | 'list' | 'get' | 'update' | 'delete';
  id?: string;
  site_id?: string;
  name?: string;
  description?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function categoriesTool(current_site_id?: string, current_user_id?: string) {
  return {
    name: 'categories',
    description:
      'Manage catalog categories. Used to retrieve category UUIDs for assigning to catalog items (category_id). Action "list" can filter by search. Returns id, name, and description.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update', 'delete'],
          description: 'Action to perform on categories.',
        },
        id: {
          type: 'string',
          description: 'UUID of the category (required for get, update, delete)',
        },
        site_id: { type: 'string', description: 'Site UUID' },
        name: { type: 'string', description: 'Name of the category (required for create)' },
        description: { type: 'string', description: 'Description of the category' },
        search: { type: 'string', description: 'Search term to filter categories by name' },
        limit: { type: 'number', description: 'Pagination limit' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['action'],
    },
    execute: async (args: CategoriesToolParams) => {
      const site_id = args.site_id || current_site_id;
      if (!site_id) {
        throw new Error('site_id is required either in arguments or context.');
      }
      
      const payload = {
        ...args,
        site_id
      };
      
      return await fetchApiTool('/api/agents/tools/categories', payload, 'Failed to perform category operation');
    },
  };
}
