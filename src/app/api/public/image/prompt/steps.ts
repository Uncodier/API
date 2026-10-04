'use step';

import { ImageGenerationService } from '@/lib/services/image/ImageGenerationService';
import { uploadToCache } from '@/lib/services/image/promptImageCache';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { readResponseWithLimit } from '@/lib/security/limited-response';

export async function generateAndCacheImageStep(
  prompt: string, 
  siteId: string, 
  size: '256x256' | '512x512' | '1024x1024',
  ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | undefined,
  hash: string
) {
  'use step';
  
  // Platform requests use the system site; signed site requests charge that site.
  const generationSize = size === '256x256' || size === '512x512' ? '1024x1024' : size;
  const result = await ImageGenerationService.generateImage({
    prompt,
    site_id: siteId,
    // Cache dimensions stay unchanged. Azure does not generate legacy tiny sizes;
    // let its adapter map non-square ratios to supported landscape/portrait sizes.
    size: ratio && ratio !== '1:1' ? undefined : generationSize,
    ratio,
    provider: 'azure'
  });

  if (!result.success || !result.images?.[0]?.url) {
    throw new Error(`Generation failed: ${result.error || 'Unknown error'}`);
  }

  const generatedUrl = result.images[0].url;

  // 2. Fetch the generated image to get the buffer
  const imageRes = await fetch(await assertSafeRemoteUrl(generatedUrl), {
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!imageRes.ok) {
    throw new Error('Failed to download generated image');
  }

  const buffer = await readResponseWithLimit(imageRes, 20 * 1024 * 1024);
  const mimeType = imageRes.headers.get('content-type') || 'image/jpeg';

  // 3. Upload to the deterministic cache path
  const cacheResult = await uploadToCache(hash, buffer, mimeType);

  // 4. Create an asset record mapping the public prompt
  try {
    if (siteId !== '00000000-0000-0000-0000-000000000000') {
      await supabaseAdmin.from('assets').insert({
        site_id: siteId,
        name: `prompt_${hash}`,
        file_path: cacheResult.url,
        file_type: mimeType,
        file_size: buffer.length,
        metadata: {
          provider: result.provider,
          model: result.metadata?.model,
          prompt,
          prompt_hash: hash,
          source: 'public_prompt',
          generated_at: new Date().toISOString(),
          storage_path: cacheResult.path,
          bucket: 'generative_images'
        },
        is_public: true
      });
    }
  } catch (dbError) {
    console.warn('[PublicPromptImage] Asset insert failed, but image was cached', dbError);
  }

  return { success: true };
}
