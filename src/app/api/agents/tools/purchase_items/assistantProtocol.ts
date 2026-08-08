/**
 * Assistant Protocol Wrapper for Purchase Items Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface PurchaseItemsToolParams {
  action: 'create' | 'list' | 'update' | 'delete';

  id?: string;
  purchase_id?: string;
  catalog_item_id?: string;
  name?: string;
  quantity?: number;
  unit_cost?: number;

  limit?: number;
  offset?: number;
}

export function purchaseItemsTool(current_site_id?: string) {
  return {
    name: 'purchase_items',
    description:
      'Manage line items on a vendor bill / purchase order. Use after creating a purchases header. Use action="create" to add a line (requires purchase_id and name or catalog_item_id). Use update/delete to change lines. Totals on the parent purchase are recalculated automatically.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'delete'],
          description: 'Action to perform on purchase items.',
        },
        id: { type: 'string', description: 'Item UUID (required for update, delete)' },
        purchase_id: { type: 'string', description: 'Purchase UUID (required for create, list)' },
        catalog_item_id: { type: 'string', description: 'Catalog Item UUID (optional; hydrates name/unit_cost)' },
        name: { type: 'string', description: 'Line name (optional if catalog_item_id is provided)' },
        quantity: { type: 'number', description: 'Quantity (defaults to 1)' },
        unit_cost: { type: 'number', description: 'Unit cost (optional if catalog_item_id provides cost)' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: PurchaseItemsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create' && (!params.purchase_id || (!params.catalog_item_id && !params.name))) {
        throw new Error('Missing required fields for create: purchase_id, and either catalog_item_id or name');
      }

      if ((action === 'list') && !params.purchase_id) {
        throw new Error('Missing required field for list: purchase_id');
      }

      if ((action === 'update' || action === 'delete') && !params.id) {
        throw new Error(`Missing required field id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        site_id: current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/purchase_items', body, `Purchase Items ${action} failed`);
    },
  };
}
