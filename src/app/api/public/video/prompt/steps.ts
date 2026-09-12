'use step';

import { uploadVideoToCache } from '@/lib/services/video/promptVideoCache';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function generateAndCacheVideoStep(
  prompt: string, 
  siteId: string, 
  durationSeconds: number,
  ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3',
  hash: string
) {
  'use step';
  
  // 1. Generate video (call local API which handles billing and provider logic)
  const apiUrl = `${process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:3000'}/api/ai/video`;
  
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.SERVICE_API_KEY || '',
    },
    body: JSON.stringify({
      prompt,
      site_id: siteId,
      duration_seconds: durationSeconds,
      aspect_ratio: ratio,
      provider: 'gemini'
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Generation failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();

  if (!result.videos?.[0]?.url) {
    throw new Error(`Generation failed: Video URL not found in response`);
  }

  const generatedUrl = result.videos[0].url;

  // 2. Fetch the generated video to get the buffer
  const videoRes = await fetch(generatedUrl);
  if (!videoRes.ok) {
    throw new Error(`Failed to download generated video from ${generatedUrl}`);
  }

  const arrayBuffer = await videoRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = videoRes.headers.get('content-type') || 'video/mp4';

  // 3. Upload to the deterministic cache path
  const cacheResult = await uploadVideoToCache(hash, buffer, mimeType);

  // 4. Create an asset record mapping the public prompt
  try {
    if (siteId !== '00000000-0000-0000-0000-000000000000') {
      await supabaseAdmin.from('assets').insert({
        site_id: siteId,
        name: `prompt_video_${hash}`,
        file_path: cacheResult.url,
        file_type: mimeType,
        file_size: buffer.length,
        metadata: {
          provider: 'gemini',
          prompt,
          prompt_hash: hash,
          source: 'public_video_prompt',
          generated_at: new Date().toISOString(),
          storage_path: cacheResult.path,
          bucket: 'generative_videos'
        },
        is_public: true
      });
    }
  } catch (dbError) {
    console.warn('[PublicPromptVideo] Asset insert failed, but video was cached', dbError);
  }

  return { success: true };
}