import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const DeleteRecordCategorySchema = z.object({
  category_id: z.string().uuid(),
  site_id: z.string().uuid(),
});

export async function deleteRecordCategoryCore(params: any) {
  const validated = DeleteRecordCategorySchema.parse(params);

  const { error } = await supabaseAdmin
    .from('record_categories')
    .delete()
    .eq('id', validated.category_id)
    .eq('site_id', validated.site_id);

  if (error) {
    throw new Error(`Failed to delete record_category: ${error.message}`);
  }

  return { success: true };
}
