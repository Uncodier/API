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

