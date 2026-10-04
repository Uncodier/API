import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const GetOrdersSchema = z.object({
  customer_id: z.string().uuid().optional(),
  sale_id: z.string().uuid().optional(),
  site_id: z.string().uuid('Site ID is required'),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Core logic for getting sales orders
 */
export async function getSalesOrdersCore(filters: Record<string, unknown>) {
  const validatedFilters = GetOrdersSchema.parse(filters);
  const { customer_id, sale_id, site_id, status, limit, offset } = validatedFilters;

  let query = supabaseAdmin
    .from('orders')
    .select('*', { count: 'exact' });

  if (customer_id) query = query.eq('customer_id', customer_id);
  if (sale_id) query = query.eq('sale_id', sale_id);
  if (site_id) query = query.eq('site_id', site_id);
  if (status) query = query.eq('status', status);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Error fetching orders: ${error.message}`);
  }

  return {
    success: true,
    data: {
      orders: data,
      pagination: {
        total: count || 0,
        count: data?.length || 0,
        offset,
        limit,
      }
    }
  };
}

