'use step';

import { uploadVideoToCache } from '@/lib/services/video/promptVideoCache';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { VideoGenerationService } from '@/lib/services/video/VideoGenerationService';
import { getCachedJson, setCachedJson } from '@/lib/security/upstash-rest';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import type { ExecutionRoutingReference } from '@/lib/services/ai/customer-routing';

export async function generateAndCacheVideoStep(
  prompt: string, 
  siteId: string, 
  durationSeconds: number,
  ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3',
  hash: string,
  executionRouting?: ExecutionRoutingReference,
) {
  'use step';
  
  // At most one submit per invocation. Persist the local job id so
  // subsequent public requests never resubmit a still-running paid generation.
  const key = `ai-video:public:${siteId}:${hash}`;
  const tracked = await getCachedJson<string | { submission_pending: true }>(key);
  if (tracked && typeof tracked !== 'string') {
    return { status: 'pending', error: 'Video submission outcome uncertain; contact support before resubmitting' };
  }
  const jobId = tracked;
  const submit = () => VideoGenerationService.generateVideo({
    prompt, site_id: siteId, duration_seconds: durationSeconds,
    aspect_ratio: ratio,
    ...(executionRouting ? { executionRouting, operationId: `public-video:${hash}` } : {}),
  });
  let result = jobId
    ? await VideoGenerationService.getVideoJob(siteId, jobId)
    : await submit();
  if (jobId && result.job_id === jobId && result.provider === 'gemini'
    && executionRouting?.payer !== 'customer' && result.status === 'failed' && result.submission_rejected === true) {
    // Persist intent before replacing the rejected job. A lost submit response
    // must not leave the old rejection as permission to generate a duplicate.
    if (!await setCachedJson(key, { submission_pending: true }, 7 * 24 * 60 * 60)
      || (await getCachedJson<{ submission_pending?: boolean }>(key))?.submission_pending !== true) {
      return { status: 'failed', job_id: jobId, error: 'Job tracking unavailable; submission was not retried' };
    }
    result = await submit();
  }
  if (result.job_id && result.job_id !== jobId) {
    if (!await setCachedJson(key, result.job_id, 7 * 24 * 60 * 60)
      || await getCachedJson<string>(key) !== result.job_id) {
      return { status: 'pending', job_id: result.job_id, error: 'Job tracking unavailable; poll this job_id directly' };
    }
  }
  if (result.status !== 'completed' || !result.success) {
    return {
      status: result.status || 'failed', job_id: result.job_id,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  if (!result.videos?.[0]?.url) {
    throw new Error(`Generation failed: Video URL not found in response`);
  }

  const generatedUrl = result.videos[0].url;

  // 2. Fetch the generated video to get the buffer
  const videoRes = await fetch(await assertSafeRemoteUrl(generatedUrl), {
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  if (!videoRes.ok) {
    throw new Error('Failed to download generated video');
  }

  const buffer = await readResponseWithLimit(videoRes, 100 * 1024 * 1024);
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
          provider: result.provider,
          model: result.metadata?.model,
          job_id: result.job_id,
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

  return { success: true, status: 'completed', job_id: result.job_id };
}