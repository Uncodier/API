import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';
import { EmbeddingsService } from '@/lib/services/embeddings-service';

const CreateRecordSchema = z.object({
  site_id: z.string().uuid(),
  category_id: z.string().uuid().optional().nullable(),
  title: z.string(),
  description: z.string().optional(),
  summary: z.string().optional(),
  data: z.record(z.any()).optional().default({}),
  relations: z.record(z.any()).optional().default({}),
  status: z.string().optional().default('draft'),
});

export async function createRecordCore(params: any) {
  const validated = CreateRecordSchema.parse(params);

  try {
    const textToEmbed = [
      validated.title,
      validated.description,
      validated.summary,
      validated.data && Object.keys(validated.data).length > 0 ? JSON.stringify(validated.data) : ''
    ].filter(Boolean).join('\n');
    
    if (textToEmbed) {
      const { embeddings } = await EmbeddingsService.generateEmbeddings(textToEmbed);
      if (embeddings && embeddings.length > 0) {
        (validated as any).embedding = embeddings[0];
      }
    }
  } catch (embedErr) {
    console.warn('[CreateRecord] Failed to generate embedding:', embedErr);
  }

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
