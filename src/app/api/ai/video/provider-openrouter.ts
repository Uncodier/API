import { MediaRequestError, openRouterMediaJson, openRouterMediaRequest } from '@/lib/services/image/openrouter-media';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import type { VideoRequestBody } from './video-types';
import { assertPlatformInference } from '@/lib/services/ai/customer-routing';

export interface PreparedVideo {
  model: string;
  prompt: string;
  duration: number;
  aspect_ratio: string;
  resolution?: string;
  frame_images?: Array<{ type: string; image_url: { url: string }; frame_type: string }>;
}

/** Legacy entry point kept fail-closed. New OpenRouter videos use customer-video.ts. */
export async function prepareOpenRouterVideo(_body: VideoRequestBody): Promise<PreparedVideo> {
  assertPlatformInference('video');
  throw new MediaRequestError('OpenRouter video requires authorized customer BYOK routing', 400);
}

export interface OpenRouterVideoJob {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  generation_id?: string;
  usage?: { cost?: number };
}

function validateJob(job: OpenRouterVideoJob): OpenRouterVideoJob {
  if (typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(job.id)
    || !['pending', 'in_progress', 'completed', 'failed'].includes(job.status)) {
    throw new MediaRequestError('OpenRouter returned an invalid video job');
  }
  return {
    id: job.id, status: job.status,
    generation_id: typeof job.generation_id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(job.generation_id)
      ? job.generation_id : undefined,
    usage: typeof job.usage?.cost === 'number' && Number.isFinite(job.usage.cost) && job.usage.cost >= 0
      ? { cost: job.usage.cost } : undefined,
  };
}

export async function submitOpenRouterVideo(_body: PreparedVideo): Promise<OpenRouterVideoJob> {
  assertPlatformInference('video');
  throw new MediaRequestError('OpenRouter video requires authorized customer BYOK routing', 400);
}

export async function pollOpenRouterVideo(id: string): Promise<OpenRouterVideoJob> {
  const job = validateJob(await openRouterMediaJson(`/videos/${encodeURIComponent(id)}`, { timeout: 20_000 }));
  if (job.id !== id) throw new MediaRequestError('OpenRouter returned a mismatched video job');
  return job;
}

export async function downloadOpenRouterVideo(id: string) {
  // Ignore unsigned_urls/polling_url from the provider; bearer never leaves fixed origin.
  const response = await openRouterMediaRequest(`/videos/${encodeURIComponent(id)}/content?index=0`, { timeout: 60_000 });
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'video/mp4';
  if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(mimeType)) {
    throw new MediaRequestError('OpenRouter returned unsupported video content');
  }
  const buffer = await readResponseWithLimit(response, 100 * 1024 * 1024);
  if (!buffer.length) throw new MediaRequestError('OpenRouter returned empty video content');
  return { buffer, mimeType };
}