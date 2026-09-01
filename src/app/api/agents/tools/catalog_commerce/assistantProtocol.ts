/**
 * Assistant Protocol Wrapper for Catalog Commerce Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export type CatalogCommerceResource =
  | 'item'
  | 'modifier_group'
  | 'modifier_group_item'
  | 'item_modifier_group'
  | 'tax'
  | 'catalog_item_tax'
  | 'item_spec_category'
  | 'item_spec'
  | 'catalog_item_spec';

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
  metadata?: Record<string, unknown>;

  // Modifiers
  modifier_group_id?: string;
  catalog_item_id?: string;
  min_select?: number;
  max_select?: number | null;
  include_modifiers?: boolean;
  include_specs?: boolean;
  include_taxes?: boolean;

  limit?: number;
  offset?: number;

  // Taxes
  rate?: number;
  is_active?: boolean;
  tax_id?: string;

  // Specs
  slug?: string;
  is_system?: boolean;
  video_url?: string;
  address?: string;
  city?: string;
  item_spec_id?: string;
}

export function catalogCommerceTool(current_site_id?: string) {
  return {
    name: 'catalog_commerce',
    description:
      'Create, search, and manage catalog items, product modifiers, tech specs, and taxes. Default resource="item": use action="create"/"list"/"get"/"update" for products. For modifiers: resource="modifier_group", resource="modifier_group_item", resource="item_modifier_group". For specs: resource="item_spec_category", resource="item_spec", resource="catalog_item_spec". For taxes: resource="tax", resource="catalog_item_tax". Use get on an item with include_modifiers=true to read attached groups and options. If you need a category_id, use the "categories" tool to list and find the correct UUID. CRITICAL: A variant inherits its parent\'s availability; if a parent is archived or unavailable, you MUST NOT list, offer, or sell its variants. By default list/get returns only bookable items; to see archived ones, explicitly pass status="archived".',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update', 'delete'],
          description:
            'Action to perform. delete is for modifier resources (groups, options, attachments), taxes, and specs.',
        },
        resource: {
          type: 'string',
          enum: [
            'item',
            'modifier_group',
            'modifier_group_item',
            'item_modifier_group',
            'tax',
            'catalog_item_tax',
            'item_spec_category',
            'item_spec',
            'catalog_item_spec',
          ],
          description:
            'Target entity. Defaults to "item". Use other resources for product extras, specs, or taxes.',
        },
        id: {
          type: 'string',
          description: 'UUID of the target row (required for get, update, delete)',
        },
        site_id: { type: 'string', description: 'Seller site UUID' },
        name: {
          type: 'string',
          description: 'Name (required for create on item, modifier_group, tax, item_spec_category, or item_spec)',
        },
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
        category_id: {
          type: 'string',
          description:
            'For resource=item: catalog category UUID. For resource=item_spec: item_spec_category UUID (not a catalog category).',
        },
        parent_id: { type: 'string', description: 'Parent catalog item UUID (for variants)' },
        pass_uses: { type: 'number', description: 'Number of uses if this is a pass (null = unlimited)' },
        pass_validity_days: { type: 'number', description: 'Days the pass is valid for' },
        search: {
          type: 'string',
          description:
            'Inferred catalog name for name/description match. Correct typos and drop filler words before searching; do not paste the raw user phrase. Prefer 1–2 words from the likely item name (e.g. user "korte de cabalero" → "corte", not "korte de cabalero" or "corte caballero"). Extra words reduce exact matches; if results are empty, retry with a shorter inferred term.',
        },
        sort_order: { type: 'number', description: 'Sort order for display' },
        metadata: { type: 'object', description: 'JSON metadata for custom attributes like to-go / dine-in' },
        modifier_group_id: {
          type: 'string',
          description: 'Modifier group UUID (for modifier_group_item / item_modifier_group)',
        },
        catalog_item_id: {
          type: 'string',
          description:
            'Catalog item UUID for modifier_group_item, item_modifier_group, catalog_item_tax, or catalog_item_spec',
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
        include_specs: {
          type: 'boolean',
          description: 'When resource=item and action=get, include attached tech specs',
        },
        include_taxes: {
          type: 'boolean',
          description: 'When resource=item and action=get, include attached taxes',
        },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
        rate: { type: 'number', description: 'Tax rate (0 to 100) (for tax)' },
        is_active: { type: 'boolean', description: 'Whether tax is active (for tax)' },
        tax_id: { type: 'string', description: 'Tax UUID (for catalog_item_tax)' },
        slug: {
          type: 'string',
          description: 'Unique slug for item_spec_category. Auto-generated from name if omitted.',
        },
        is_system: { type: 'boolean', description: 'Is system category (for item_spec_category)' },
        video_url: { type: 'string', description: 'Video URL (for item_spec)' },
        address: { type: 'string', description: 'Address (for item_spec)' },
        city: { type: 'string', description: 'City (for item_spec)' },
        item_spec_id: { type: 'string', description: 'Spec UUID (for catalog_item_spec)' },
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

      if (resource === 'tax' || resource === 'item_spec_category') {
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

      if (resource === 'item_spec') {
        if (action === 'create' && (!params.name || !params.category_id)) {
          throw new Error('Missing required fields for create: name, category_id');
        }
        if (action === 'create' && !site_id) {
          throw new Error('Missing required field for create: site_id');
        }
        if ((action === 'update' || action === 'get' || action === 'delete') && !params.id) {
          throw new Error(`Missing required field id for action ${action}`);
        }
      }

      if (resource === 'catalog_item_tax') {
        if (action === 'update') {
          throw new Error('update is not supported for catalog_item_tax; delete and create instead');
        }
        if (action === 'create' && (!params.catalog_item_id || !params.tax_id)) {
          throw new Error('Missing required fields for create: catalog_item_id, tax_id');
        }
        if (action === 'create' && !site_id) {
          throw new Error('Missing required field for create: site_id');
        }
        if ((action === 'get' || action === 'delete') && !params.id) {
          throw new Error(`Missing required field id for action ${action}`);
        }
      }

      if (resource === 'catalog_item_spec') {
        if (action === 'create' && (!params.catalog_item_id || !params.item_spec_id)) {
          throw new Error('Missing required fields for create: catalog_item_id, item_spec_id');
        }
        if (action === 'create' && !site_id) {
          throw new Error('Missing required field for create: site_id');
        }
        if ((action === 'update' || action === 'get' || action === 'delete') && (!params.catalog_item_id || !params.item_spec_id)) {
          throw new Error(`Missing required fields catalog_item_id and item_spec_id for action ${action}`);
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
