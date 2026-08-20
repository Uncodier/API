import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function getCompaniesCore(filters: {
  company_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  try {
    let query = supabaseAdmin.from('companies').select('*');

    if (filters.company_id) {
      query = query.eq('id', filters.company_id);
    }

    if (filters.search) {
      query = query.ilike('name', `%${filters.search}%`);
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
      console.error('Error fetching companies:', error);
      throw new Error(error.message);
    }

    return { success: true, data };
  } catch (error: any) {
    console.error('getCompaniesCore error:', error);
    throw new Error(error.message || 'Error fetching companies');
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const company_id = searchParams.get('company_id') || undefined;
    const search = searchParams.get('search') || undefined;
    const limitParam = searchParams.get('limit');
    const offsetParam = searchParams.get('offset');

    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    const offset = offsetParam ? parseInt(offsetParam, 10) : undefined;

    const result = await getCompaniesCore({
      company_id,
      search,
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
