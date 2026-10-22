'use step';

import { ImageGenerationService } from '@/lib/services/image/ImageGenerationService';
import { uploadToCache } from '@/lib/services/image/promptImageCache';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import { getStepMetadata } from 'workflow';

export async function generateImageStep(
  prompt: string, 
  siteId: string, 
  size: '256x256' | '512x512' | '1024x1024',
  ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | undefined
) {
  'use step';
  
  // Authorization is performed at ingress. Only real internal principals may
  // select SYSTEM; signed requests and authenticated users select their tenant.
  const generationSize = size === '256x256' || size === '512x512' ? '1024x1024' : size;
  let operationId: string | undefined;
  try {
    // Server-issued invocation ID; never derive this from client input/cache hash.
    operationId = `workflow-image:${getStepMetadata().stepId}`;
  } catch (error) {
    // Compatibility: direct (non-workflow) callers have no SDK context. The API
    // assigns a fresh operation ID; neither this service nor the step retries.
    if (!(error instanceof Error) || error.message !== '`getStepMetadata()` can only be called inside a step function') {
      throw error;
    }
  }
  const params = {
    prompt,
    site_id: siteId,
    // Cache dimensions stay unchanged. Azure does not generate legacy tiny sizes;
    // let its adapter map non-square ratios to supported landscape/portrait sizes.
    size: ratio && ratio !== '1:1' ? undefined : generationSize,
    ratio,
    provider: 'azure' as const
  };
  const result = operationId
    ? await ImageGenerationService.generateImage(params, { operationId })
    : await ImageGenerationService.generateImage(params);

  if (!result.success || !result.images?.[0]?.url) {
    throw new Error(`Generation failed: ${result.error || 'Unknown error'}`);
  }

  // Persist this paid result in the workflow log BEFORE attempting cache I/O.
  return { url: result.images[0].url, provider: result.provider, model: result.metadata?.model };
}

// A timeout/unknown outcome must never trigger a second paid POST.
generateImageStep.maxRetries = 0;

export async function cacheGeneratedImageStep(
  generated: { url: string; provider: string; model?: string },
  prompt: string,
  siteId: string,
  hash: string,
) {
  'use step';

  // 2. Fetch the generated image to get the buffer
  const imageRes = await fetch(await assertSafeRemoteUrl(generated.url), {
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
          provider: generated.provider,
          model: generated.model,
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
  } catch {
    console.warn('[PublicPromptImage] Asset insert failed, but image was cached');
  }

  return { success: true };
}

// Only download + deterministic storage writes are retryable. Never generate here.
cacheGeneratedImageStep.maxRetries = 3;

/** Backward-compatible entrypoint for older workflows/callers. No paid replay. */
export async function generateAndCacheImageStep(
  prompt: string,
  siteId: string,
  size: '256x256' | '512x512' | '1024x1024',
  ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | undefined,
  hash: string,
) {
  'use step';

  const generated = await generateImageStep(prompt, siteId, size, ratio);
  return cacheGeneratedImageStep(generated, prompt, siteId, hash);
}
generateAndCacheImageStep.maxRetries = 0;
