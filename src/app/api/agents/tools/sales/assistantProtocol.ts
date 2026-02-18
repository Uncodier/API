/**
 * Assistant Protocol Wrapper for Sales Tool
 * Unified tool for managing sales (create, list, update)
 */

import { getSalesCore } from '@/app/api/agents/tools/sales/get/route';

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface SalesToolParams {
  action: 'create' | 'list' | 'update' | 'delete';
  
  // Create params
  customer_id?: string;
  product_ids?: string[];
  payment_method?: string;
  total_amount?: number;
  status?: string;
  notes?: string;
  discount?: number;
  tax?: number;
  shipping_address?: Record<string, unknown>;
  site_id?: string;

  // Update/Delete params
  sale_id?: string;

  // List params
  limit?: number;
  offset?: number;
}

/**
 * Creates a sales tool for OpenAI/assistant compatibility
 */
export function salesTool(current_site_id?: string) {
  return {
    name: 'sales',
    description:
      'Manage sales transactions. Use action="create" to record a new sale. Use action="update" to modify a sale record. Use action="list" to search sales history. Use action="delete" to remove a sale record.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'delete'],
          description: 'Action to perform on sales.'
        },
        customer_id: { type: 'string', description: 'Customer UUID' },
        sale_id: { type: 'string', description: 'Sale UUID (required for update/delete)' },
        product_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of product UUIDs',
        },
        payment_method: { type: 'string', description: 'Payment method (e.g. card, transfer)' },
        total_amount: { type: 'number', description: 'Total amount' },
        status: { type: 'string', description: 'completed, pending, cancelled, etc.' },
        notes: { type: 'string', description: 'Sales notes' },
        discount: { type: 'number', description: 'Discount amount' },
        tax: { type: 'number', description: 'Tax amount' },
        shipping_address: { type: 'object', description: 'Shipping address' },
        site_id: { type: 'string', description: 'Site UUID' },
        limit: { type: 'number', description: 'Limit results' },
        offset: { type: 'number', description: 'Offset results' },
      },
      required: ['action'],
    },
    execute: async (args: SalesToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        if (!params.customer_id || !params.product_ids || !params.payment_method || params.total_amount === undefined) {
           throw new Error('Missing required fields for create sale: customer_id, product_ids, payment_method, total_amount');
        }

        const body = {
          ...params,
          site_id: params.site_id || current_site_id,
        };

        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/sales/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Sale creation failed');
        }
        return data;
      }

      if (action === 'update') {
        if (!params.sale_id) {
          throw new Error('Missing sale_id for update action');
        }
        const body = {
          ...params,
          site_id: params.site_id || current_site_id,
        };
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/sales/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Sale update failed');
        }
        return data;
      }

      if (action === 'delete') {
        if (!params.sale_id) {
          throw new Error('Missing sale_id for delete action');
        }
        const body = {
          sale_id: params.sale_id,
          site_id: params.site_id || current_site_id,
        };
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/sales/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Sale deletion failed');
        }
        return data;
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id: params.site_id || current_site_id,
        };
        return getSalesCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
