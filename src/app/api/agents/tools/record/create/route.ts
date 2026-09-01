import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const CreateRecordSchema = z.object({
  site_id: z.string().uuid(),
  category_id: z.string().uuid().optional().nullable(),
  title: z.string(),
  description: z.string().optional(),
  data: z.record(z.any()).optional().default({}),
  relations: z.record(z.any()).optional().default({}),
  status: z.string().optional().default('draft'),
});

export async function createRecordCore(params: any) {
  const validated = CreateRecordSchema.parse(params);

  const { data, error } = await supabaseAdmin
    .from('records')
    .insert(validated)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create record: ${error.message}`);
  }

  // Trigger db_event for workflows
  try {
    const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
    fireWorkflowDispatch({ table: 'records', op: 'insert', row: data, site_id: data.site_id });
  } catch (dispatchErr) {
    console.error('[CreateRecord] Failed to dispatch workflow event:', dispatchErr);
  }

  return { success: true, data };
}
