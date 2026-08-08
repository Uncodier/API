/**
 * Assistant Protocol Wrapper for Purchases (Vendor Bills / PO) Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface PurchasesToolParams {
  action: 'create' | 'list' | 'get' | 'update' | 'delete' | 'register_payment';

  id?: string;
  site_id?: string;
  title?: string;
  vendor_company_id?: string | null;
  status?: string;
  amount_due?: number;
  currency?: string;
  purchase_date?: string;
  location_id?: string | null;
  notes?: string | null;

  // register_payment
  amount?: number;
  method?: string;
  payment_notes?: string;

  limit?: number;
  offset?: number;
}

export function purchasesTool(current_site_id?: string) {
  return {
    name: 'purchases',
    description:
      'Manage vendor bills / purchase orders (accounts payable). Use for money owed or paid to suppliers — NOT buyer checkout. Use action="create" for a draft header (requires title). Use purchase_items to add lines. Use action="register_payment" to record a supplier payment. Use list/get/update/delete for CRUD.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update', 'delete', 'register_payment'],
          description: 'Action to perform on purchases (vendor bills).',
        },
        id: { type: 'string', description: 'Purchase UUID (required for get, update, delete, register_payment)' },
        site_id: { type: 'string', description: 'Site UUID' },
        title: { type: 'string', description: 'Bill / PO title (required for create)' },
        vendor_company_id: { type: 'string', description: 'Vendor company UUID' },
        status: {
          type: 'string',
          enum: ['draft', 'pending', 'completed', 'cancelled'],
          description: 'Purchase status: draft, pending, completed, cancelled',
        },
        amount_due: { type: 'number', description: 'Amount still due to the vendor' },
        currency: { type: 'string', description: 'Currency code (e.g. USD, MXN)' },
        purchase_date: { type: 'string', description: 'Purchase date (YYYY-MM-DD)' },
        location_id: { type: 'string', description: 'Location UUID (warehouse / site location)' },
        notes: { type: 'string', description: 'Notes for the purchase' },
        amount: { type: 'number', description: 'Payment amount (required for register_payment)' },
        method: { type: 'string', description: 'Payment method (required for register_payment), e.g. cash, transfer, card' },
        payment_notes: { type: 'string', description: 'Optional notes for register_payment' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: PurchasesToolParams) => {
      const { action, ...params } = args;

      if (action === 'create' && !params.title) {
        throw new Error('Missing required field for create: title');
      }

      if (
        (action === 'update' || action === 'delete' || action === 'get' || action === 'register_payment') &&
        !params.id
      ) {
        throw new Error(`Missing required field id for action ${action}`);
      }

      if (action === 'register_payment') {
        if (!params.amount || params.amount <= 0) {
          throw new Error('Missing or invalid amount for register_payment');
        }
        if (!params.method) {
          throw new Error('Missing required field for register_payment: method');
        }
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      if (action === 'create' && !body.site_id) {
        throw new Error('Missing required field for create: site_id');
      }

      return await fetchApiTool('/api/agents/tools/purchases', body, `Purchases ${action} failed`);
    },
  };
}
