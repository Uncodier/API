import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface SubscriptionsToolParams {
  action: 'list' | 'get' | 'create' | 'update';
  id?: string;
  site_id?: string;
  lead_id?: string;
  buyer_user_id?: string;
  catalog_item_id?: string;
  status?: string;
  current_period_start?: string;
  current_period_end?: string;
  amount?: number;
  limit?: number;
  offset?: number;
}

export function subscriptionsTool(current_site_id?: string) {
  return {
    name: 'subscriptions',
    description:
      'Manage commercial subscriptions. Use action="create" to manually register an active subscription (e.g., when paid outside Stripe). Use action="list" to find subscriptions. Use action="get" to read a single subscription. Use action="update" to change status.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update'],
          description: 'Action to perform.'
        },
        id: { type: 'string', description: 'Subscription UUID (required for get/update)' },
        site_id: { type: 'string', description: 'Seller site UUID (defaults to current site)' },
        lead_id: { type: 'string', description: 'Lead UUID' },
        buyer_user_id: { type: 'string', description: 'Buyer user UUID' },
        catalog_item_id: { type: 'string', description: 'Catalog item UUID of the plan (required for create)' },
        status: { type: 'string', enum: ['active', 'canceled', 'past_due', 'trialing'], description: 'Subscription status (defaults to active on create)' },
        current_period_start: { type: 'string', description: 'ISO date string for start of billing period. (Also mapped to start_date)' },
        current_period_end: { type: 'string', description: 'ISO date string for end of billing period. (Also mapped to end_date)' },
        amount: { type: 'number', description: 'The recurring amount or price for the subscription' },
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
      
      if (action === 'update' && !params.id) {
        throw new Error('Missing required field id for action update');
      }
      
      if (action === 'create' && !params.catalog_item_id) {
        throw new Error('Missing required field catalog_item_id for action create');
      }

      if (action === 'create' && !params.lead_id && !params.buyer_user_id) {
        throw new Error('Must provide either lead_id or buyer_user_id for action create');
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
