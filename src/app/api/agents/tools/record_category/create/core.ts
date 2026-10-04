import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const CreateRecordCategorySchema = z.object({
  site_id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  parent_category_id: z.string().uuid().optional().nullable(),
  template_fields: z.array(z.any()).optional().default([]),
});

export async function createRecordCategoryCore(params: any) {
  const validated = CreateRecordCategorySchema.parse(params);

  const { data, error } = await supabaseAdmin
    .from('record_categories')
    .insert(validated)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create record_category: ${error.message}`);
  }

  return { success: true, data };
}
