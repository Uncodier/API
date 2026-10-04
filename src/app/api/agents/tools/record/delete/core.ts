import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const DeleteRecordSchema = z.object({
  record_id: z.string().uuid(),
  site_id: z.string().uuid(),
});

export async function deleteRecordCore(params: any) {
  const validated = DeleteRecordSchema.parse(params);

  // We need to fetch the record first to have the row data for the webhook payload
  const { data: record, error: fetchError } = await supabaseAdmin
    .from('records')
    .select('*')
    .eq('id', validated.record_id)
    .eq('site_id', validated.site_id)
    .single();
    
  if (fetchError || !record) {
    throw new Error(`Failed to fetch record for deletion: ${fetchError?.message || 'Not found'}`);
  }

  const { error } = await supabaseAdmin
    .from('records')
    .delete()
    .eq('id', validated.record_id)
    .eq('site_id', validated.site_id);

  if (error) {
    throw new Error(`Failed to delete record: ${error.message}`);
  }

  // Trigger db_event for workflows
  try {
    const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
    fireWorkflowDispatch({ table: 'records', op: 'delete', row: record, site_id: record.site_id });
  } catch (dispatchErr) {
    console.error('[DeleteRecord] Failed to dispatch workflow event:', dispatchErr);
  }

  return { success: true };
}
