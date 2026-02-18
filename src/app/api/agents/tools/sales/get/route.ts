import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const GetSalesSchema = z.object({
  customer_id: z.string().uuid().optional(),
  site_id: z.string().uuid('Site ID is required'),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export async function getSalesCore(filters: Record<string, unknown>) {
  const validatedFilters = GetSalesSchema.parse(filters);
  const { customer_id, site_id, status, limit, offset } = validatedFilters;

  let query = supabaseAdmin
    .from('sales')
    .select('*', { count: 'exact' });

  if (customer_id) query = query.eq('customer_id', customer_id);
  if (site_id) query = query.eq('site_id', site_id);
  if (status) query = query.eq('status', status);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Error fetching sales: ${error.message}`);

  return {
    success: true,
    data: {
      sales: data,
      pagination: { total: count || 0, count: data?.length || 0, offset, limit }
    }
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getSalesCore(body);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('[GetSales] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid filters', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: "Sales query API",
    usage: "POST with filters",
    filters: ["customer_id", "site_id", "status", "limit", "offset"]
  });
}
