import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface PassRedeemableItemsToolParams {
  action: 'list' | 'create' | 'delete';
  id?: string;
  site_id?: string;
  pass_catalog_item_id?: string;
  reservable_catalog_item_id?: string;
  limit?: number;
  offset?: number;
}

export function passRedeemableItemsTool(current_site_id?: string) {
  return {
    name: 'pass_redeemable_items',
    description:
      'Manage which reservable items can be booked using a specific pass. Use action="create" to link a pass (digital_subtype="pass") to a reservable item (is_reservation=true). Use action="list" to view links, and "delete" to remove them.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'delete'],
          description: 'Action to perform.'
        },
        id: { type: 'string', description: 'Link UUID (required for delete)' },
        site_id: { type: 'string', description: 'Seller site UUID (defaults to current site)' },
        pass_catalog_item_id: { type: 'string', description: 'Catalog item UUID of the pass' },
        reservable_catalog_item_id: { type: 'string', description: 'Catalog item UUID of the reservable service' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: PassRedeemableItemsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create' && (!params.pass_catalog_item_id || !params.reservable_catalog_item_id)) {
        throw new Error('Missing required fields for create: pass_catalog_item_id, reservable_catalog_item_id');
      }

      if (action === 'delete' && !params.id) {
        throw new Error('Missing required field id for action delete');
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/pass_redeemable_items', body, `Pass Redeemable Items ${action} failed`);
    }
  };
}
