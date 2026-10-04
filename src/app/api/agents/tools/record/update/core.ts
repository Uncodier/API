import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';
import { EmbeddingsService } from '@/lib/services/embeddings-service';

const UpdateRecordSchema = z.object({
  record_id: z.string().uuid(),
  site_id: z.string().uuid(),
  category_id: z.string().uuid().optional().nullable(),
  title: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  data: z.record(z.any()).optional(),
  relations: z.record(z.any()).optional(),
  status: z.string().optional(),
});

export async function updateRecordCore(params: any) {
  const validated = UpdateRecordSchema.parse(params);
  const { record_id, site_id, ...updates } = validated;

  // We need to generate a new embedding if fields affecting it are updated
  if (updates.title || updates.description || updates.summary || updates.data) {
    try {
      // Fetch existing record to combine old and new values for a complete embedding
      const { data: existingRecord } = await supabaseAdmin
        .from('records')
        .select('title, description, summary, data')
        .eq('id', record_id)
        .eq('site_id', site_id)
        .single();

      if (existingRecord) {
        const title = updates.title !== undefined ? updates.title : existingRecord.title;
        const description = updates.description !== undefined ? updates.description : existingRecord.description;
        const summary = updates.summary !== undefined ? updates.summary : existingRecord.summary;
        const data = updates.data !== undefined ? updates.data : existingRecord.data;

        const textToEmbed = [
          title,
          description,
          summary,
          data && Object.keys(data).length > 0 ? JSON.stringify(data) : ''
        ].filter(Boolean).join('\n');

        if (textToEmbed) {
          const { embeddings } = await EmbeddingsService.generateEmbeddings(textToEmbed);
          if (embeddings && embeddings.length > 0) {
            (updates as any).embedding = embeddings[0];
          }
        }
      }
    } catch (embedErr) {
      console.warn('[UpdateRecord] Failed to generate embedding:', embedErr);
    }
  }

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
