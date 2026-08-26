import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface PromotionsToolParams {
  action: 'create' | 'list' | 'get' | 'update' | 'delete';
  id?: string;
  promotion_id?: string;
  site_id?: string;
  user_id?: string;
  campaign_id?: string;
  name?: string;
  description?: string;
  code?: string;
  discount_type?: 'percent' | 'fixed' | 'bogo';
  discount_value?: number;
  applies_to?: 'all' | 'selected_items';
  min_order_amount?: number;
  usage_limit?: number;
  usage_limit_per_user?: number;
  status?: 'draft' | 'active' | 'paused' | 'expired';
  starts_at?: string;
  ends_at?: string;
  channels?: string[];
  location_ids?: string[];
  active_weekdays?: number[];
  required_items_mode?: 'all' | 'any';
  bogo_buy_qty?: number;
  bogo_get_qty?: number;
  image_url?: string;
  show_on_shop?: boolean;
  show_on_marketplace?: boolean;
  currency?: string;
  catalog_item_ids?: string[];
  catalog_category_ids?: string[];
  required_items?: Array<{ catalog_item_id: string; min_quantity?: number }>;
  required_categories?: Array<{ catalog_category_id: string; min_quantity?: number }>;
  search?: string;
  active_now?: boolean;
  limit?: number;
  offset?: number;
}

export function promotionsTool(current_site_id?: string, current_user_id?: string) {
  return {
    name: 'promotions',
    description:
      'Manage commerce promotions (percent, fixed, or BOGO). Every promotion belongs to a campaign — call campaigns.list or campaigns.create first to get campaign_id. Use action="create" (requires name, discount_type, discount_value, campaign_id). Use list/get to inspect. Use update/delete with id (alias: promotion_id). If applies_to="selected_items", pass catalog_item_ids and/or catalog_category_ids. For BOGO, required_items / required_categories are the buy-side; catalog_* ids are the get-side. usage_count is read-only. Customer Support: prefer list/get with status="active"; only create/update/delete when the merchant explicitly asks. Checkout does not apply promo codes yet — never invent a discounted total.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update', 'delete'],
          description:
            'Action to perform. create needs name, discount_type, discount_value, campaign_id. get/update/delete need id (or promotion_id).',
        },
        id: {
          type: 'string',
          description: 'Promotion UUID. Required for get, update, delete. Alias of promotion_id.',
        },
        promotion_id: {
          type: 'string',
          description: 'Alias of id. Same promotion UUID.',
        },
        site_id: { type: 'string', description: 'Seller site UUID (defaults to current site)' },
        user_id: { type: 'string', description: 'Owner user UUID (defaults to site owner)' },
        campaign_id: {
          type: 'string',
          description: 'Campaign UUID (required for create). Use the campaigns tool first.',
        },
        name: { type: 'string', description: 'Promotion name (required for create)' },
        description: { type: 'string', description: 'Promotion description' },
        code: { type: 'string', description: 'Optional promo code; unique per site when set' },
        discount_type: {
          type: 'string',
          enum: ['percent', 'fixed', 'bogo'],
          description: 'percent, fixed, or bogo',
        },
        discount_value: {
          type: 'number',
          description: 'Percent 0-100, fixed amount, or BOGO marker value',
        },
        applies_to: {
          type: 'string',
          enum: ['all', 'selected_items'],
          description: 'all (default) or selected_items (requires catalog_item_ids or catalog_category_ids)',
        },
        min_order_amount: { type: 'number', description: 'Minimum order amount to qualify' },
        usage_limit: { type: 'number', description: 'Global max redemptions' },
        usage_limit_per_user: { type: 'number', description: 'Per-user redemption cap' },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'paused', 'expired'],
          description: 'draft (default), active, paused, expired',
        },
        starts_at: { type: 'string', description: 'Validity start (ISO timestamptz)' },
        ends_at: { type: 'string', description: 'Validity end (ISO timestamptz)' },
        channels: {
          type: 'array',
          items: { type: 'string', enum: ['marketplace', 'shop', 'pos'] },
          description: 'Channels where the promo applies (default marketplace, shop, pos)',
        },
        location_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional business location UUIDs',
        },
        active_weekdays: {
          type: 'array',
          items: { type: 'number' },
          description: '0-6 (Sun-Sat) when the promo is valid',
        },
        required_items_mode: {
          type: 'string',
          enum: ['all', 'any'],
          description: 'Whether all or any required items/categories must be in the cart',
        },
        bogo_buy_qty: { type: 'number', description: 'BOGO buy quantity (default 1)' },
        bogo_get_qty: { type: 'number', description: 'BOGO get quantity (default 1)' },
        image_url: { type: 'string', description: 'Public image URL' },
        show_on_shop: { type: 'boolean', description: 'Show on shop' },
        show_on_marketplace: { type: 'boolean', description: 'Show on marketplace' },
        currency: { type: 'string', description: 'Currency code (e.g. MXN, USD)' },
        catalog_item_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Catalog item UUIDs the discount applies to (get-side for BOGO). Replace-if-provided on update.',
        },
        catalog_category_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Catalog category UUIDs the discount applies to. Replace-if-provided on update.',
        },
        required_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              catalog_item_id: { type: 'string' },
              min_quantity: { type: 'number' },
            },
          },
          description: 'Items required to qualify (buy-side for BOGO). Replace-if-provided on update.',
        },
        required_categories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              catalog_category_id: { type: 'string' },
              min_quantity: { type: 'number' },
            },
          },
          description: 'Categories required to qualify. Replace-if-provided on update.',
        },
        search: { type: 'string', description: 'Search name or code on list' },
        active_now: {
          type: 'boolean',
          description: 'On list, only promotions whose starts_at/ends_at window includes now',
        },
        limit: { type: 'number', description: 'Max results for list (default 50)' },
        offset: { type: 'number', description: 'Pagination offset for list' },
      },
      required: ['action'],
    },
    execute: async (args: PromotionsToolParams) => {
      const { action, promotion_id, ...params } = args;
      const id = params.id || promotion_id;

      if (action === 'create') {
        if (!params.name || !params.discount_type || params.discount_value == null || !params.campaign_id) {
          throw new Error(
            'Missing required fields for create: name, discount_type, discount_value, campaign_id'
          );
        }
      }

      if ((action === 'get' || action === 'update' || action === 'delete') && !id) {
        throw new Error(`Missing promotion UUID for ${action}. Pass id (alias: promotion_id).`);
      }

      const body = {
        action,
        ...params,
        id,
        site_id: params.site_id || current_site_id,
        user_id: params.user_id || current_user_id,
      };

      return await fetchApiTool('/api/agents/tools/promotions', body, `Promotions ${action} failed`);
    },
  };
}
