import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const GetRecordCategoriesSchema = z.object({
  site_id: z.string().uuid(),
  category_id: z.string().uuid().optional(),
  name: z.string().optional(),
  limit: z.number().int().optional().default(50),
  offset: z.number().int().optional().default(0),
});

export async function getRecordCategoriesCore(params: any) {
  const validated = GetRecordCategoriesSchema.parse(params);

  let query = supabaseAdmin
    .from('record_categories')
    .select('*')
    .eq('site_id', validated.site_id);

  if (validated.category_id) {
    query = query.eq('id', validated.category_id);
  }
  if (validated.name) {
    query = query.ilike('name', `%${validated.name}%`);
  }

  query = query.range(validated.offset, validated.offset + validated.limit - 1);

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Failed to fetch record_categories: ${error.message}`);
  }

  return { success: true, data: { categories: data, total: count || data.length } };
}
