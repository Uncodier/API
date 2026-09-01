import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const UpdateRecordSchema = z.object({
  record_id: z.string().uuid(),
  site_id: z.string().uuid(),
  category_id: z.string().uuid().optional().nullable(),
  title: z.string().optional(),
  description: z.string().optional(),
  data: z.record(z.any()).optional(),
  relations: z.record(z.any()).optional(),
  status: z.string().optional(),
});

export async function updateRecordCore(params: any) {
  const validated = UpdateRecordSchema.parse(params);
  const { record_id, site_id, ...updates } = validated;

  const { data, error } = await supabaseAdmin
    .from('records')
    .update(updates)
    .eq('id', record_id)
    .eq('site_id', site_id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update record: ${error.message}`);
  }

  // Trigger db_event for workflows
  try {
    const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
    fireWorkflowDispatch({ table: 'records', op: 'update', row: data, site_id: data.site_id });
  } catch (dispatchErr) {
    console.error('[UpdateRecord] Failed to dispatch workflow event:', dispatchErr);
  }

  return { success: true, data };
}
