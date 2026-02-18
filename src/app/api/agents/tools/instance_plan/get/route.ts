import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const GetInstancePlansSchema = z.object({
  instance_id: z.string().uuid('Invalid instance_id').optional(),
  site_id: z.string().uuid('Site ID is required'),
  user_id: z.string().uuid('Invalid user_id').optional(),
  agent_id: z.string().uuid('Invalid agent_id').optional(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled', 'paused', 'in_progress']).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export async function getInstancePlansCore(filters: Record<string, unknown>) {
  const validatedFilters = GetInstancePlansSchema.parse(filters);

  let query = supabaseAdmin
    .from('instance_plans')
    .select('*', { count: 'exact' });

  if (validatedFilters.instance_id) {
    query = query.eq('instance_id', validatedFilters.instance_id);
  }
  if (validatedFilters.site_id) {
    query = query.eq('site_id', validatedFilters.site_id);
  }
  if (validatedFilters.user_id) {
    query = query.eq('user_id', validatedFilters.user_id);
  }
  if (validatedFilters.agent_id) {
    query = query.eq('agent_id', validatedFilters.agent_id);
  }
  if (validatedFilters.status) {
    query = query.eq('status', validatedFilters.status);
  }

  query = query
    .order('created_at', { ascending: false })
    .range(validatedFilters.offset, validatedFilters.offset + validatedFilters.limit - 1);

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Error fetching instance plans: ${error.message}`);
  }

  return {
    success: true,
    data: {
      plans: data,
      pagination: {
        total: count,
        count: data.length,
        offset: validatedFilters.offset,
        limit: validatedFilters.limit,
        has_more: (count || 0) > validatedFilters.offset + data.length,
      },
      filters_applied: validatedFilters,
    },
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getInstancePlansCore(body);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[GetInstancePlan] Error:', error);
    if (error instanceof z.ZodError) {
        return NextResponse.json({ success: false, error: 'Invalid filters', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
  }
}
