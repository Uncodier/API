/**
 * Assistant Protocol Wrapper for Sales Order Tool
 * Unified tool for managing sales orders (create, list, update)
 */

import { getSalesOrdersCore } from '@/app/api/agents/tools/sales-order/get/route';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';



export interface SalesOrderToolParams {
  action: 'create' | 'list' | 'update' | 'delete';
  
  // Create params
  customer_id?: string;
  product_ids?: string[] | string;
  payment_method?: string;
  total_amount?: number;
  create_order?: boolean;
  status?: string;
  notes?: string;
  discount?: number;
  tax?: number;
  shipping_address?: Record<string, unknown>;
  order_details?: Record<string, unknown>;
  location_id?: string;

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
    description: 'Legacy CRM transaction recording tool. Do not use for checkouts, Stripe payment links, catalog purchases, or new commerce flows. For creating orders with payment links, use the `checkout` tool instead. Note: compatible discounts are applied automatically; you will receive any automatically applied discounts in the tool result, which you must communicate to the customer.',
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
          type: 'string',
          description: 'Array of product UUIDs (for create, comma-separated string)',
        },
        payment_method: { type: 'string', description: 'Payment method (e.g. card, transfer)' },
        total_amount: { type: 'number', description: 'Total amount' },
        create_order: { type: 'boolean', description: 'Create full order record' },
        status: { type: 'string', description: 'pending, completed, etc.' },
        notes: { type: 'string', description: 'Order notes' },
        discount: { type: 'number', description: 'Discount amount' },
        tax: { type: 'number', description: 'Tax amount' },
        shipping_address: { type: 'string', description: 'Shipping address (JSON string)' },
        order_details: { type: 'string', description: 'Additional order details (JSON string)' },
        location_id: { type: 'string', description: 'Location UUID for inventory' },
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
          product_ids: params.product_ids && typeof params.product_ids === 'string' ? params.product_ids.split(',').map(id => id.trim()) : params.product_ids,
          shipping_address: params.shipping_address && typeof params.shipping_address === 'string' ? JSON.parse(params.shipping_address) : params.shipping_address,
          order_details: params.order_details && typeof params.order_details === 'string' ? JSON.parse(params.order_details) : params.order_details,
          site_id: params.site_id || current_site_id,
        };

        const data = await fetchApiTool('/api/agents/tools/sales-order/create', body, 'Sales order creation failed');
        return data;
      }

      if (action === 'update') {
        if (!params.order_id) {
          throw new Error('Missing order_id for update action');
        }
        const body = {
          ...params,
          product_ids: params.product_ids && typeof params.product_ids === 'string' ? params.product_ids.split(',').map(id => id.trim()) : params.product_ids,
          shipping_address: params.shipping_address && typeof params.shipping_address === 'string' ? JSON.parse(params.shipping_address) : params.shipping_address,
          order_details: params.order_details && typeof params.order_details === 'string' ? JSON.parse(params.order_details) : params.order_details,
          site_id: params.site_id || current_site_id,
        };
        const data = await fetchApiTool('/api/agents/tools/sales-order/update', body, 'Sales order update failed');
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
        const data = await fetchApiTool('/api/agents/tools/sales-order/delete', body, 'Sales order deletion failed');
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
