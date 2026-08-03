import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface SubscriptionsToolParams {
  action: 'list' | 'get';
  id?: string;
  site_id?: string;
  lead_id?: string;
  buyer_user_id?: string;
  catalog_item_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export function subscriptionsTool(current_site_id?: string) {
  return {
    name: 'subscriptions',
    description:
      'Read commercial subscriptions. Use action="list" to find subscriptions by buyer, lead, or status. Use action="get" to read a single subscription. Subscriptions are created by backend webhooks, not via this tool.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get'],
          description: 'Action to perform.'
        },
        id: { type: 'string', description: 'Subscription UUID (required for get)' },
        site_id: { type: 'string', description: 'Seller site UUID (defaults to current site)' },
        lead_id: { type: 'string', description: 'Lead UUID' },
        buyer_user_id: { type: 'string', description: 'Buyer user UUID' },
        catalog_item_id: { type: 'string', description: 'Catalog item UUID of the plan' },
        status: { type: 'string', enum: ['active', 'canceled', 'past_due', 'trialing'], description: 'Subscription status' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: SubscriptionsToolParams) => {
      const { action, ...params } = args;

      if (action === 'get' && !params.id) {
        throw new Error('Missing required field id for action get');
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/subscriptions', body, `Subscriptions ${action} failed`);
    }
  };
}
