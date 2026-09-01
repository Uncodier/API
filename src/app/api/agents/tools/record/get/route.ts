import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const GetRecordsSchema = z.object({
  site_id: z.string().uuid(),
  record_id: z.string().uuid().optional(),
  category_id: z.string().uuid().optional(),
  status: z.string().optional(),
  title: z.string().optional(),
  limit: z.number().int().optional().default(50),
  offset: z.number().int().optional().default(0),
});

export async function getRecordsCore(params: any) {
  const validated = GetRecordsSchema.parse(params);

  let query = supabaseAdmin
    .from('records')
    .select('*, category:record_categories(*)')
    .eq('site_id', validated.site_id);

  if (validated.record_id) {
    query = query.eq('id', validated.record_id);
  }
  if (validated.category_id) {
    query = query.eq('category_id', validated.category_id);
  }
  if (validated.status) {
    query = query.eq('status', validated.status);
  }
  if (validated.title) {
    query = query.ilike('title', `%${validated.title}%`);
  }

  query = query.range(validated.offset, validated.offset + validated.limit - 1)
               .order('created_at', { ascending: false });

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Failed to fetch records: ${error.message}`);
  }

  return { success: true, data: { records: data, total: count || data.length } };
}
