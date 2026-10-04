import { resolveOpenRouterModel } from '@/lib/services/ai/openrouter';
import { MediaRequestError, openRouterMediaJson, openRouterMediaRequest } from '@/lib/services/image/openrouter-media';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import type { VideoRequestBody } from './video-types';

interface VideoModel {
  id: string;
  supported_durations?: number[];
  supported_aspect_ratios?: string[];
  supported_resolutions?: string[];
  supported_frame_images?: string[];
}

export interface PreparedVideo {
  model: string;
  prompt: string;
  duration: number;
  aspect_ratio: string;
  resolution?: string;
  frame_images?: Array<{ type: string; image_url: { url: string }; frame_type: string }>;
}

export async function prepareOpenRouterVideo(body: VideoRequestBody): Promise<PreparedVideo> {
  // Deliberately no default Sora 2 Pro substitution: operators must opt in to its pricing.
  const configured = process.env.OPENROUTER_VIDEO_MODEL?.trim();
  if (!configured) throw new MediaRequestError('Video generation requires explicit OPENROUTER_VIDEO_MODEL configuration', 503);
  const modelId = resolveOpenRouterModel(body.model || configured);
  const models = await openRouterMediaJson<{ data: VideoModel[] }>('/videos/models');
  const model = models.data?.find(item => item.id === modelId);
  if (!model) throw new MediaRequestError('Selected model is not available in the OpenRouter Video API', 400);
  const duration = body.duration_seconds ?? 4;
  const ratio = body.aspect_ratio ?? '16:9';
  if (!model.supported_durations?.includes(duration)) {
    throw new MediaRequestError('Selected video model does not support requested duration_seconds', 400);
  }
  if (!model.supported_aspect_ratios?.includes(ratio)) {
    throw new MediaRequestError('Selected video model does not support requested aspect_ratio', 400);
  }
  if (body.quality !== undefined) {
    throw new MediaRequestError('quality is a legacy Gemini option; use resolution for OpenRouter video', 400);
  }
  if (body.resolution && !model.supported_resolutions?.includes(body.resolution)) {
    throw new MediaRequestError('Selected video model does not support requested resolution', 400);
  }
  // The current catalog has no reference-image capability descriptor. Do not silently
  // turn style references into a first frame (a different generation mode).
  if (body.reference_images?.length) {
    throw new MediaRequestError('OpenRouter reference_images are not supported by this integration; use explicit frame URLs', 400);
  }
  const frames = [
    ...(body.first_frame_url ? [{ type: 'image_url', image_url: { url: body.first_frame_url }, frame_type: 'first_frame' }] : []),
    ...(body.last_frame_url ? [{ type: 'image_url', image_url: { url: body.last_frame_url }, frame_type: 'last_frame' }] : []),
  ];
  if (frames.some(frame => !model.supported_frame_images?.includes(frame.frame_type))) {
    throw new MediaRequestError('Selected video model does not support requested frame images', 400);
  }
  return {
    model: modelId, prompt: body.prompt, duration, aspect_ratio: ratio,
    ...(body.resolution ? { resolution: body.resolution } : {}),
    ...(frames.length ? { frame_images: frames } : {}),
  };
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

export async function submitOpenRouterVideo(body: PreparedVideo): Promise<OpenRouterVideoJob> {
  // No retries: a lost submit response could represent a billed, accepted job.
  return validateJob(await openRouterMediaJson('/videos', { body, timeout: 30_000 }));
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