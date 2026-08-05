/**
 * Assistant Protocol Wrapper for Catalog Commerce Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface CatalogCommerceToolParams {
  action: 'create' | 'list' | 'get' | 'update';

  id?: string;
  site_id?: string;
  name?: string;
  description?: string;
  sku?: string;
  image_url?: string;
  cost?: number;
  lowest_sale_price?: number;
  target_sale_price?: number;
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
  parent_id?: string;
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
      'Create, search, and manage catalog items. Use action="create" to add a new product/service/digital_asset (requires name; set target_sale_price and is_purchasable for sellable items). Use action="list" to search items. Use action="update" to change name, pricing, listing flags, status, or digital_subtype. Use action="get" to read an item.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update'],
          description: 'Action to perform on catalog items.',
        },
        id: { type: 'string', description: 'Catalog Item UUID (required for get, update)' },
        site_id: { type: 'string', description: 'Seller site UUID' },
        name: { type: 'string', description: 'Item name (required for create)' },
        description: { type: 'string', description: 'Item description' },
        sku: { type: 'string', description: 'SKU code (unique per site)' },
        image_url: { type: 'string', description: 'Public HTTP URL for the product image' },
        cost: { type: 'number', description: 'Cost / COGS' },
        lowest_sale_price: { type: 'number', description: 'Minimum allowed sale price' },
        target_sale_price: { type: 'number', description: 'Default sale price used by checkout/quotes' },
        kind: { type: 'string', enum: ['product', 'service', 'digital_asset'], description: 'Kind: product, service, digital_asset' },
        digital_subtype: { type: 'string', description: 'Subtype: ticket, course, file, pass, license' },
        is_marketplace_listed: { type: 'boolean', description: 'True if visible in the marketplace' },
        is_reservation: { type: 'boolean', description: 'True if item requires scheduling/booking before checkout' },
        is_purchasable: { type: 'boolean', description: 'True if item can be bought' },
        is_recurring: { type: 'boolean', description: 'True if item is a subscription plan' },
        is_pos_available: { type: 'boolean', description: 'True if item is available in Point of Sale' },
        status: { type: 'string', enum: ['active', 'archived'], description: 'Status: active, archived' },
        availability_status: {
          type: 'string',
          enum: ['available', 'unavailable', 'sold_out'],
          description: 'Availability: available, unavailable, sold_out',
        },
        currency: { type: 'string', description: 'Currency code (e.g. USD, MXN)' },
        category_id: { type: 'string', description: 'Category UUID' },
        parent_id: { type: 'string', description: 'Parent catalog item UUID (for variants)' },
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

      if (action === 'create' && !params.name) {
        throw new Error('Missing required field for create: name');
      }

      if ((action === 'update' || action === 'get') && !params.id) {
        throw new Error(`Missing required field id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      if (action === 'create' && !body.site_id) {
        throw new Error('Missing required field for create: site_id');
      }

      return await fetchApiTool('/api/agents/tools/catalog_commerce', body, `Catalog Commerce ${action} failed`);
    },
  };
}
