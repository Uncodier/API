/**
 * Assistant Protocol Wrapper for Catalog Commerce Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export type CatalogCommerceResource =
  | 'item'
  | 'modifier_group'
  | 'modifier_group_item'
  | 'item_modifier_group';

export interface CatalogCommerceToolParams {
  action: 'create' | 'list' | 'get' | 'update' | 'delete';
  resource?: CatalogCommerceResource;

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
  sort_order?: number;

  // Modifiers
  modifier_group_id?: string;
  catalog_item_id?: string;
  min_select?: number;
  max_select?: number | null;
  include_modifiers?: boolean;

  limit?: number;
  offset?: number;
}

export function catalogCommerceTool(current_site_id?: string) {
  return {
    name: 'catalog_commerce',
    description:
      'Create, search, and manage catalog items and product modifiers. Default resource="item": use action="create"/"list"/"get"/"update" for products. For modifiers: resource="modifier_group" (selection rules), resource="modifier_group_item" (options = catalog items in a group), resource="item_modifier_group" (attach a group to a host product). Use get on an item with include_modifiers=true to read attached groups and options.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update', 'delete'],
          description:
            'Action to perform. delete is for modifier resources (groups, options, attachments).',
        },
        resource: {
          type: 'string',
          enum: ['item', 'modifier_group', 'modifier_group_item', 'item_modifier_group'],
          description:
            'Target entity. Defaults to "item". Use modifier_group / modifier_group_item / item_modifier_group for product extras.',
        },
        id: {
          type: 'string',
          description: 'UUID of the target row (required for get, update, delete)',
        },
        site_id: { type: 'string', description: 'Seller site UUID' },
        name: { type: 'string', description: 'Name (required for create on item or modifier_group)' },
        description: { type: 'string', description: 'Description' },
        sku: { type: 'string', description: 'SKU code (unique per site)' },
        image_url: { type: 'string', description: 'Public HTTP URL for the product image' },
        cost: { type: 'number', description: 'Cost / COGS' },
        lowest_sale_price: { type: 'number', description: 'Minimum allowed sale price' },
        target_sale_price: { type: 'number', description: 'Default sale price used by checkout/quotes' },
        kind: {
          type: 'string',
          enum: ['product', 'service', 'digital_asset'],
          description: 'Kind: product, service, digital_asset',
        },
        digital_subtype: { type: 'string', description: 'Subtype: ticket, course, file, pass, license' },
        is_marketplace_listed: { type: 'boolean', description: 'True if visible in the marketplace' },
        is_reservation: {
          type: 'boolean',
          description: 'True if item requires a capacity slot via reservations/checkout (not the scheduling tool)',
        },
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
        sort_order: { type: 'number', description: 'Sort order for display' },
        modifier_group_id: {
          type: 'string',
          description: 'Modifier group UUID (for modifier_group_item / item_modifier_group)',
        },
        catalog_item_id: {
          type: 'string',
          description:
            'Catalog item UUID — option item for modifier_group_item, or host product for item_modifier_group',
        },
        min_select: {
          type: 'number',
          description: 'Minimum options a buyer must pick from the group (modifier_group)',
        },
        max_select: {
          type: 'number',
          description: 'Maximum options a buyer may pick (null = unlimited). Must be >= min_select.',
        },
        include_modifiers: {
          type: 'boolean',
          description: 'When resource=item and action=get, include attached modifier groups and options',
        },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: CatalogCommerceToolParams) => {
      const { action, resource = 'item', ...params } = args;
      const site_id = params.site_id || current_site_id;

      if (resource === 'item') {
        if (action === 'create' && !params.name) {
          throw new Error('Missing required field for create: name');
        }
        if ((action === 'update' || action === 'get') && !params.id) {
          throw new Error(`Missing required field id for action ${action}`);
        }
        if (action === 'delete') {
          throw new Error('delete is not supported for resource=item; use status=archived via update');
        }
        if (action === 'create' && !site_id) {
          throw new Error('Missing required field for create: site_id');
        }
      }

      if (resource === 'modifier_group') {
        if (action === 'create' && !params.name) {
          throw new Error('Missing required field for create: name');
        }
        if (action === 'create' && !site_id) {
          throw new Error('Missing required field for create: site_id');
        }
        if ((action === 'update' || action === 'get' || action === 'delete') && !params.id) {
          throw new Error(`Missing required field id for action ${action}`);
        }
      }

      if (resource === 'modifier_group_item') {
        if (action === 'create' && (!params.modifier_group_id || !params.catalog_item_id)) {
          throw new Error('Missing required fields for create: modifier_group_id, catalog_item_id');
        }
        if (action === 'create' && !site_id) {
          throw new Error('Missing required field for create: site_id');
        }
        if ((action === 'update' || action === 'get' || action === 'delete') && !params.id) {
          throw new Error(`Missing required field id for action ${action}`);
        }
      }

      if (resource === 'item_modifier_group') {
        if (action === 'create' && (!params.catalog_item_id || !params.modifier_group_id)) {
          throw new Error('Missing required fields for create: catalog_item_id, modifier_group_id');
        }
        if (action === 'create' && !site_id) {
          throw new Error('Missing required field for create: site_id');
        }
        if ((action === 'update' || action === 'get' || action === 'delete') && !params.id) {
          throw new Error(`Missing required field id for action ${action}`);
        }
      }

      const body = {
        action,
        resource,
        ...params,
        site_id,
      };

      return await fetchApiTool('/api/agents/tools/catalog_commerce', body, `Catalog Commerce ${action} failed`);
    },
  };
}
