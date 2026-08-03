import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface PriceListsToolParams {
  action: 'list' | 'get';
  id?: string;
  site_id?: string;
  is_active?: boolean;
  is_default?: boolean;
  limit?: number;
  offset?: number;
}

export function priceListsTool(current_site_id?: string) {
  return {
    name: 'price_lists',
    description:
      'Read price lists and their items. Use action="list" to find price lists for the site. Use action="get" with the price list UUID to get the list and all its overridden catalog prices (price_list_items).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get'],
          description: 'Action to perform.'
        },
        id: { type: 'string', description: 'Price list UUID (required for get)' },
        site_id: { type: 'string', description: 'Seller site UUID (defaults to current site)' },
        is_active: { type: 'boolean', description: 'Filter active lists' },
        is_default: { type: 'boolean', description: 'Filter default list' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: PriceListsToolParams) => {
      const { action, ...params } = args;

      if (action === 'get' && !params.id) {
        throw new Error('Missing required field id for action get');
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/price_lists', body, `Price Lists ${action} failed`);
    }
  };
}
