/**
 * Assistant Protocol Wrapper for Checkout Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface CheckoutToolParams {
  action: 'create_order' | 'create_order_from_quotation' | 'create_payment_link' | 'get_order';

  site_id?: string;
  buyer_user_id?: string;
  customer_email?: string;
  owner_site_id?: string;
  lead_id?: string;
  source?: 'quote' | 'marketplace' | 'shop' | 'sales' | 'retail' | 'online' | 'pos';
  lines?: any[] | string;
  
  quotation_id?: string;

  order_id?: string;
  return_url?: string;
}

export function checkoutTool(current_site_id?: string) {
  return {
    name: 'checkout',
    description:
      'Manage checkouts. Use action="create_order_from_quotation" to convert a sent quotation into a pending order. Use action="create_order" to build an order from scratch. Use action="create_payment_link" to generate a Stripe Checkout URL for a pending order. Share this URL with the buyer so they can pay. Payment completion and entitlement grants happen via the commerce Stripe webhook (market-fit), not this tool. Use action="get_order" to check order status.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_order', 'create_order_from_quotation', 'create_payment_link', 'get_order'],
          description: 'Action to perform on checkout.',
        },
        site_id: { type: 'string', description: 'Seller site UUID (defaults to current site)' },
        buyer_user_id: {
          type: 'string',
          description: 'Buyer user UUID (required for digital assets/subscriptions)',
        },
        customer_email: {
          type: 'string',
          description: 'Customer email — used for Stripe checkout and lead resolution',
        },
        owner_site_id: { type: 'string', description: 'Owner site UUID (for B2B destination)' },
        lead_id: { type: 'string', description: 'Lead UUID to attach to the sale' },
        quotation_id: { type: 'string', description: 'Quotation UUID to convert into an order' },
        source: {
          type: 'string',
          description: 'Source of the order: online, pos, retail, shop, marketplace',
        },
        lines: {
          type: 'string',
          description:
            'JSON string of order lines. Each line needs: catalogItemId, quantity, and optionally unitPriceOverride. For reservable items (is_reservation=true), you MUST include reservationStart and reservationEnd (ISO dates).',
        },
        order_id: {
          type: 'string',
          description: 'Order UUID (required for create_payment_link, get_order)',
        },
        return_url: {
          type: 'string',
          description:
            'URL to redirect buyer after Stripe payment. Defaults to commerce app /buyer/orders.',
        },
      },
      required: ['action'],
    },
    execute: async (args: CheckoutToolParams) => {
      const { action, lines, ...params } = args;
      const site_id = params.site_id || current_site_id;

      if (action === 'create_order') {
        if (!lines) throw new Error('Missing required field for create_order: lines');
        if (!site_id) throw new Error('Missing required field for create_order: site_id');
      }

      if (action === 'create_order_from_quotation') {
        if (!params.quotation_id) throw new Error('Missing required field: quotation_id');
        if (!site_id) throw new Error('Missing required field: site_id');
      }

      if ((action === 'create_payment_link' || action === 'get_order') && !params.order_id) {
        throw new Error(`Missing required field order_id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        lines: lines && typeof lines === 'string' ? JSON.parse(lines) : lines,
        site_id,
      };

      return await fetchApiTool('/api/agents/tools/checkout', body, `Checkout ${action} failed`);
    },
  };
}
