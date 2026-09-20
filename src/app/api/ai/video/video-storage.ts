import { supabaseAdmin } from '@/lib/database/supabase-client';

const VIDEO_BUCKET = 'generative_videos';

export async function persistGeneratedVideo(input: {
  buffer: Buffer;
  mimeType: string;
  siteId: string;
  prompt: string;
  model: string;
  instanceId?: string;
  metadata: Record<string, unknown>;
}): Promise<{ url: string; mimeType: string }> {
  const extension = input.mimeType.includes('webm')
    ? 'webm'
    : input.mimeType.includes('mov')
      ? 'mov'
      : 'mp4';
  const path =
    `${input.siteId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const { data: uploaded, error: uploadError } = await supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .upload(path, input.buffer, {
      contentType: input.mimeType,
      upsert: false,
    });
  if (uploadError || !uploaded?.path) {
    throw new Error(uploadError?.message || 'Video upload failed');
  }

  let url = supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .getPublicUrl(path)
    .data?.publicUrl || '';
  if (!url) {
    const { data: signed, error } = await supabaseAdmin.storage
      .from(VIDEO_BUCKET)
      .createSignedUrl(path, 7 * 24 * 60 * 60);
    if (error || !signed?.signedUrl) {
      throw new Error(error?.message || 'Unable to create video URL');
    }
    url = signed.signedUrl;
  }

  const { data: ownership } = await supabaseAdmin
    .from('site_ownership')
    .select('user_id')
    .eq('site_id', input.siteId)
    .maybeSingle();
  const asset: Record<string, unknown> = {
    site_id: input.siteId,
    name: `gemini_video_${Date.now()}.${extension}`,
    file_path: url,
    file_type: input.mimeType,
    file_size: input.buffer.length,
    metadata: {
      provider: 'gemini',
      prompt: input.prompt,
      generated_at: new Date().toISOString(),
      model: input.model,
      storage_path: path,
      bucket: VIDEO_BUCKET,
      ...input.metadata,
    },
    is_public: true,
  };
  if (ownership?.user_id) asset.user_id = ownership.user_id;
  if (input.instanceId) asset.instance_id = input.instanceId;
  const { error: assetError } = await supabaseAdmin.from('assets').insert(asset);
  if (assetError) {
    console.warn('[Video API] Unable to save asset record:', assetError.message);
  }

  return { url, mimeType: input.mimeType };
}
