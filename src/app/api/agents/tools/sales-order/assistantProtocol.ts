/**
 * Assistant Protocol Wrapper for Sales Order Tool
 * Unified tool for managing sales orders (create, list, update)
 */

import { getSalesOrdersCore } from '@/app/api/agents/tools/sales-order/get/route';

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface SalesOrderToolParams {
  action: 'create' | 'list' | 'update' | 'delete';
  
  // Create params
  customer_id?: string;
  product_ids?: string[];
  payment_method?: string;
  total_amount?: number;
  create_order?: boolean;
  status?: string;
  notes?: string;
  discount?: number;
  tax?: number;
  shipping_address?: Record<string, unknown>;
  order_details?: Record<string, unknown>;

  // Update/Delete params
  order_id?: string;
  delivery_date?: string;
  shipping_method?: string;
  priority?: string;

  // List params
  sale_id?: string;
  site_id?: string;
  limit?: number;
  offset?: number;
}

/**
 * Creates a sales_order tool for OpenAI/assistant compatibility
 */
export function salesOrderTool(current_site_id?: string) {
  return {
    name: 'sales_order',
    description:
      'Manage sales orders. Use action="create" to create a sales record and optionally an order. Use action="update" to update an order. Use action="list" to search orders. Use action="delete" to remove an order.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'delete'],
          description: 'Action to perform on sales orders.'
        },
        customer_id: { type: 'string', description: 'Customer UUID' },
        order_id: { type: 'string', description: 'Order UUID (required for update/delete)' },
        product_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of product UUIDs (for create)',
        },
        payment_method: { type: 'string', description: 'Payment method (e.g. card, transfer)' },
        total_amount: { type: 'number', description: 'Total amount' },
        create_order: { type: 'boolean', description: 'Create full order record' },
        status: { type: 'string', description: 'pending, completed, etc.' },
        notes: { type: 'string', description: 'Order notes' },
        discount: { type: 'number', description: 'Discount amount' },
        tax: { type: 'number', description: 'Tax amount' },
        shipping_address: { type: 'object', description: 'Shipping address' },
        order_details: { type: 'object', description: 'Additional order details' },
        delivery_date: { type: 'string', description: 'Delivery date (for update)' },
        shipping_method: { type: 'string', description: 'Shipping method (for update)' },
        priority: { type: 'string', description: 'Priority: low, medium, high (for update)' },
        sale_id: { type: 'string', description: 'Sale UUID (for list)' },
        site_id: { type: 'string', description: 'Site UUID (for list)' },
        limit: { type: 'number', description: 'Limit results' },
        offset: { type: 'number', description: 'Offset results' },
      },
      required: ['action'],
    },
    execute: async (args: SalesOrderToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        if (!params.customer_id || !params.product_ids || !params.payment_method || params.total_amount === undefined) {
           throw new Error('Missing required fields for create sales order: customer_id, product_ids, payment_method, total_amount');
        }

        const body = {
          ...params,
          site_id: params.site_id || current_site_id,
        };

        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/sales-order/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Sales order creation failed');
        }
        return data;
      }

      if (action === 'update') {
        if (!params.order_id) {
          throw new Error('Missing order_id for update action');
        }
        const body = {
          ...params,
          site_id: params.site_id || current_site_id,
        };
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/sales-order/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Sales order update failed');
        }
        return data;
      }

      if (action === 'delete') {
        if (!params.order_id) {
          throw new Error('Missing order_id for delete action');
        }
        const body = {
          order_id: params.order_id,
          site_id: params.site_id || current_site_id,
        };
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/sales-order/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Sales order deletion failed');
        }
        return data;
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id: params.site_id || current_site_id,
        };
        return getSalesOrdersCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
