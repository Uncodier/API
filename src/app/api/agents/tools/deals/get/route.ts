import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function getDealsCore(filters: {
  site_id?: string;
  deal_id?: string;
  stage?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  try {
    let query = supabaseAdmin.from('deals').select('*');

    if (filters.site_id) {
      query = query.eq('site_id', filters.site_id);
    }

    if (filters.deal_id) {
      query = query.eq('id', filters.deal_id);
    }

    if (filters.stage) {
      query = query.eq('stage', filters.stage);
    }

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    if (filters.limit) {
      query = query.limit(filters.limit);
    }

    if (filters.offset !== undefined) {
      const start = filters.offset;
      const end = start + (filters.limit || 10) - 1;
      query = query.range(start, end);
    }

    query = query.order('created_at', { ascending: false });

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching deals:', error);
      throw new Error(error.message);
    }

    return { success: true, data };
  } catch (error: any) {
    console.error('getDealsCore error:', error);
    throw new Error(error.message || 'Error fetching deals');
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const site_id = searchParams.get('site_id') || undefined;
    const deal_id = searchParams.get('deal_id') || undefined;
    const stage = searchParams.get('stage') || undefined;
    const status = searchParams.get('status') || undefined;
    const limitParam = searchParams.get('limit');
    const offsetParam = searchParams.get('offset');

    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    const offset = offsetParam ? parseInt(offsetParam, 10) : undefined;

    const result = await getDealsCore({
      site_id,
      deal_id,
      stage,
      status,
      limit,
      offset,
    });

    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
