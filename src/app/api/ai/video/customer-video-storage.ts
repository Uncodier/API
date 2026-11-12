import { supabaseAdmin } from '@/lib/database/supabase-client';

const bucket = 'generative_videos';
type Input = { buffer: Buffer; mimeType: string; siteId: string; eventId: string;
  instanceId?: string; prompt: string; model: string; metadata: Record<string, unknown> };

/** The dispatch event UUID is also the asset PK and immutable object key. No random retry identities. */
export async function persistCustomerVideo(input: Input): Promise<{ url: string; mimeType: string }> {
  const path = `${input.siteId}/customer/${input.eventId}.mp4`;
  const find = async () => {
    const { data, error } = await supabaseAdmin.from('assets').select('site_id,file_path,file_type,metadata')
      .eq('id', input.eventId).maybeSingle();
    if (error) throw new Error('Customer video asset lookup failed');
    if (!data) return null;
    if (data.site_id !== input.siteId || data.metadata?.receipt_event_id !== input.eventId
        || data.metadata?.storage_path !== path || data.file_type !== input.mimeType || !data.file_path) {
      throw new Error('Customer video asset identity conflict');
    }
    return { url: data.file_path as string, mimeType: data.file_type as string };
  };
  const existing = await find();
  if (existing) return existing;
  const storage = supabaseAdmin.storage.from(bucket);
  const { data, error } = await storage.upload(path, input.buffer, { contentType: input.mimeType, upsert: false });
  if (error) {
    if (!['409', 'Duplicate'].includes(String(error.statusCode)) && error.message !== 'The resource already exists') {
      throw new Error('Customer video upload failed');
    }
    // A prior upload may have committed without an ACK. Verify its bytes; never overwrite it.
    const stored = await storage.download(path);
    if (stored.error || !stored.data || !Buffer.from(await stored.data.arrayBuffer()).equals(input.buffer)) {
      throw new Error('Customer video storage conflict');
    }
  } else if (data?.path !== path) throw new Error('Customer video upload acknowledgement missing');
  const url = storage.getPublicUrl(path).data?.publicUrl;
  if (!url) throw new Error('Customer video URL unavailable');
  const { data: ownership, error: ownerError } = await supabaseAdmin.from('site_ownership')
    .select('user_id').eq('site_id', input.siteId).maybeSingle();
  if (ownerError) throw new Error('Customer video ownership unavailable');
  const { error: insertError } = await supabaseAdmin.from('assets').insert({
    id: input.eventId, site_id: input.siteId, name: `openrouter_video_${input.eventId}.mp4`,
    file_path: url, file_type: input.mimeType, file_size: input.buffer.length, is_public: true,
    ...(ownership?.user_id ? { user_id: ownership.user_id } : {}),
    ...(input.instanceId ? { instance_id: input.instanceId } : {}),
    metadata: { ...input.metadata, provider: 'openrouter', payer: 'customer', prompt: input.prompt,
      model: input.model, receipt_event_id: input.eventId, storage_path: path, bucket },
  });
  if (insertError && insertError.code !== '23505') throw new Error('Customer video asset persistence failed');
  // Includes concurrent duplicate and lost insert-ACK recovery, using the first durable result.
  const persisted = await find();
  if (!persisted) throw new Error('Customer video asset acknowledgement missing');
  return persisted;
}