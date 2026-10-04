import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const UpdateRecordCategorySchema = z.object({
  category_id: z.string().uuid(),
  site_id: z.string().uuid(),
  name: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  parent_category_id: z.string().uuid().optional().nullable(),
  template_fields: z.array(z.any()).optional(),
});

export async function updateRecordCategoryCore(params: any) {
  const validated = UpdateRecordCategorySchema.parse(params);
  const { category_id, site_id, ...updates } = validated;

  const { data, error } = await supabaseAdmin
    .from('record_categories')
    .update(updates)
    .eq('id', category_id)
    .eq('site_id', site_id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update record_category: ${error.message}`);
  }

  return { success: true, data };
}
