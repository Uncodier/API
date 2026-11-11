import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { randomUUID } from 'node:crypto';

const CreateAssetSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  file_type: z.string().min(1, 'File type is required'),
  site_id: z.string().uuid('Site ID is required'),
  instance_id: z.string().uuid('Valid instance_id required'),
  content: z.string(),
  metadata: z.any().optional(),
});

export async function createAssetCore(input: any) {
  const validated = CreateAssetSchema.parse(input);

  // Verificar que la instancia existe y pertenece al sitio
  const { data: instance, error: instanceError } = await supabaseAdmin
    .from('remote_instances')
    .select('site_id, user_id')
    .eq('id', validated.instance_id)
    .single();

  if (instanceError) {
    console.error(`[CreateAsset] Error verifying instance in remote_instances: ${instanceError.message}`, instanceError);
    // Don't throw here if just checking, but logic says if error or !instance, 404
  }
  
  if (instanceError || !instance) {
    throw new Error('Instance not found'); // Will catch in POST or caller
  }

  if (instance.site_id !== validated.site_id) {
    throw new Error('La instancia no pertenece a este sitio');
  }
  if (!instance.user_id) throw new Error('Instance owner not found');
  if (!/^(text\/|txt$|text$|md$|markdown$|csv$|json$|application\/json$)/i.test(validated.file_type)) {
    throw new Error('Inline assets require a text file type');
  }

  const id = randomUUID();
  const assetData = {
    id,
    user_id: instance.user_id,
    file_path: `inline:${id}`,
    name: validated.name,
    file_type: validated.file_type,
    instance_id: validated.instance_id,
    site_id: validated.site_id,
    content: validated.content,
    metadata: validated.metadata,
  };

  const { data: asset, error } = await supabaseAdmin
    .from('assets')
    .insert(assetData)
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return asset;
}