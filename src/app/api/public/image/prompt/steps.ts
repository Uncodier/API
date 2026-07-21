'use step';

import { ImageGenerationService } from '@/lib/services/image/ImageGenerationService';
import { uploadToCache } from '@/lib/services/image/promptImageCache';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function generateAndCacheImageStep(
  prompt: string, 
  siteId: string, 
  size: '256x256' | '512x512' | '1024x1024',
  ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | undefined,
  hash: string
) {
  'use step';
  
  // 1. Generate image (this will internally charge credits to the siteId)
  const result = await ImageGenerationService.generateImage({
    prompt,
    site_id: siteId,
    size,
    ratio,
    provider: 'gemini'
  });

  if (!result.success || !result.images?.[0]?.url) {
    throw new Error(`Generation failed: ${result.error || 'Unknown error'}`);
  }

  const generatedUrl = result.images[0].url;

  // 2. Fetch the generated image to get the buffer
  const imageRes = await fetch(generatedUrl);
  if (!imageRes.ok) {
    throw new Error(`Failed to download generated image from ${generatedUrl}`);
  }

  const arrayBuffer = await imageRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = imageRes.headers.get('content-type') || 'image/jpeg';

  // 3. Upload to the deterministic cache path
  const cacheResult = await uploadToCache(hash, buffer, mimeType);

  // 4. Create an asset record mapping the public prompt
  await supabaseAdmin.from('assets').insert({
    site_id: siteId,
    name: `prompt_${hash}`,
    file_path: cacheResult.url,
    file_type: mimeType,
    file_size: buffer.length,
    metadata: {
      provider: 'gemini',
      prompt,
      prompt_hash: hash,
      source: 'public_prompt',
      generated_at: new Date().toISOString(),
      storage_path: cacheResult.path,
      bucket: 'generative_images'
    },
    is_public: true
  });

  return { success: true };
}
