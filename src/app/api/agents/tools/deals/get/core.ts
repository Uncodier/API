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

