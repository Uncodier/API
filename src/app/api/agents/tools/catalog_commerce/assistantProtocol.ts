/**
 * Assistant Protocol Wrapper for Catalog Commerce Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface CatalogCommerceToolParams {
  action: 'list' | 'get' | 'update';
  
  id?: string;
  site_id?: string;
  kind?: string;
  digital_subtype?: string;
  is_marketplace_listed?: boolean;
  is_reservation?: boolean;
  is_purchasable?: boolean;
  is_recurring?: boolean;
  is_pos_available?: boolean;
  status?: string;
  availability_status?: string;
  currency?: string;
  category_id?: string;
  pass_uses?: number;
  pass_validity_days?: number;
  search?: string;
  
  limit?: number;
  offset?: number;
}

export function catalogCommerceTool(current_site_id?: string) {
  return {
    name: 'catalog_commerce',
    description:
      'Search and manage commercial settings for catalog items. Use action="list" to search items (you can filter by is_marketplace_listed=true or digital_subtype). Use action="update" to change listing visibility (is_marketplace_listed), status, or digital_subtype. Use action="get" to read an item.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'update'],
          description: 'Action to perform on catalog items.'
        },
        id: { type: 'string', description: 'Catalog Item UUID (required for get, update)' },
        site_id: { type: 'string', description: 'Seller site UUID' },
        kind: { type: 'string', description: 'Kind: product, service, digital_asset' },
        digital_subtype: { type: 'string', description: 'Subtype: ticket, course, file, pass, license' },
        is_marketplace_listed: { type: 'boolean', description: 'True if visible in the marketplace' },
        is_reservation: { type: 'boolean', description: 'True if item requires scheduling/booking before checkout' },
        is_purchasable: { type: 'boolean', description: 'True if item can be bought' },
        is_recurring: { type: 'boolean', description: 'True if item is a subscription plan' },
        is_pos_available: { type: 'boolean', description: 'True if item is available in Point of Sale' },
        status: { type: 'string', enum: ['active', 'draft', 'archived'], description: 'Status: active, draft, archived' },
        availability_status: { type: 'string', enum: ['available', 'unavailable'], description: 'Availability: available, unavailable' },
        currency: { type: 'string', description: 'Currency code (e.g. USD)' },
        category_id: { type: 'string', description: 'Category UUID' },
        pass_uses: { type: 'number', description: 'Number of uses if this is a pass (null = unlimited)' },
        pass_validity_days: { type: 'number', description: 'Days the pass is valid for' },
        search: { type: 'string', description: 'Search term for name/description' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: CatalogCommerceToolParams) => {
      const { action, ...params } = args;

      if ((action === 'update' || action === 'get') && !params.id) {
        throw new Error(`Missing required field id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/catalog_commerce', body, `Catalog Commerce ${action} failed`);
    }
  };
}
