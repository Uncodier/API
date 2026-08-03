/**
 * Assistant Protocol Wrapper for Subscription Plan Items Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface SubscriptionPlanItemsToolParams {
  action: 'list' | 'create' | 'delete';
  
  id?: string;
  site_id?: string;
  plan_catalog_item_id?: string;
  digital_catalog_item_id?: string;
  
  limit?: number;
  offset?: number;
}

export function subscriptionPlanItemsTool(current_site_id?: string) {
  return {
    name: 'subscription_plan_items',
    description:
      'Manage mappings between a subscription plan and its included digital assets. Use action="create" to map a digital asset to a plan. Use action="list" to read existing mappings. Use action="delete" to remove a mapping.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'delete'],
          description: 'Action to perform on subscription plan items.'
        },
        id: { type: 'string', description: 'Item UUID (required for delete)' },
        site_id: { type: 'string', description: 'Seller site UUID' },
        plan_catalog_item_id: { type: 'string', description: 'The plan catalog item UUID' },
        digital_catalog_item_id: { type: 'string', description: 'The digital catalog item UUID included in the plan' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: SubscriptionPlanItemsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create' && (!params.plan_catalog_item_id || !params.digital_catalog_item_id)) {
        throw new Error('Missing required fields for create: plan_catalog_item_id, digital_catalog_item_id');
      }
      
      if (action === 'delete' && !params.id) {
        throw new Error(`Missing required field id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/subscription_plan_items', body, `Subscription Plan Items ${action} failed`);
    }
  };
}
