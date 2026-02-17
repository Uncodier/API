/**
 * Assistant Protocol Wrapper for Sales Order Tool
 * Create sales records and orders
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface SalesOrderToolParams {
  customer_id: string;
  product_ids: string[];
  payment_method: string;
  total_amount: number;
  create_order?: boolean;
  status?: string;
  notes?: string;
  discount?: number;
  tax?: number;
  shipping_address?: Record<string, unknown>;
  order_details?: Record<string, unknown>;
}

/**
 * Creates a sales_order tool for OpenAI/assistant compatibility
 */
export function salesOrderTool(site_id?: string) {
  return {
    name: 'sales_order',
    description:
      'Create a sales record and optionally an order. Required: customer_id (UUID), product_ids (array of UUIDs), payment_method, total_amount. Optional: create_order, status, notes, discount, tax, shipping_address, order_details.',
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer UUID' },
        product_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of product UUIDs',
        },
        payment_method: { type: 'string', description: 'Payment method (e.g. card, transfer)' },
        total_amount: { type: 'number', description: 'Total amount' },
        create_order: { type: 'boolean', description: 'Create full order record' },
        status: { type: 'string', description: 'pending, completed, etc.' },
        notes: { type: 'string', description: 'Order notes' },
        discount: { type: 'number', description: 'Discount amount' },
        tax: { type: 'number', description: 'Tax amount' },
        shipping_address: { type: 'object', description: 'Shipping address' },
        order_details: { type: 'object', description: 'Additional order details (required if create_order)' },
      },
      required: ['customer_id', 'product_ids', 'payment_method', 'total_amount'],
    },
    execute: async (args: SalesOrderToolParams) => {
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/sales-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Sales order failed');
      }
      return data;
    },
  };
}
