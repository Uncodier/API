import { assertPlatformInference } from '@/lib/services/ai/customer-routing';
import { MediaRequestError } from '@/lib/services/image/media-request-error';
import { downloadPinnedImage } from '@/lib/security/pinned-image-download';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import type { PreparedVideo, OpenRouterVideoJob } from './provider-openrouter';
import type { VideoRequestBody } from './video-types';

interface GeminiInputImage { imageBytes: string; mimeType: string }

export const GEMINI_VIDEO_DEFAULT_MODEL = 'gemini-omni-1.2-flash';
export function getGeminiVideoModel(): string {
  return process.env.GEMINI_VIDEO_MODEL?.trim() || GEMINI_VIDEO_DEFAULT_MODEL;
}
const GOOGLE_ORIGIN = 'https://generativelanguage.googleapis.com';

export interface GeminiPreparedVideo extends PreparedVideo {
  geminiConfig: Record<string, never>;
  omniInput?: Array<{ type: 'image'; data: string; mime_type: string } | { type: 'text'; text: string }>;
  omniTask?: 'reference_to_video' | 'image_to_video';
}

function apiKey(): string {
  assertPlatformInference('video');
  const key = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!key) throw new MediaRequestError('Gemini video is not configured: set GEMINI_API_KEY', 503);
  return key;
}

async function downloadImage(value: string): Promise<GeminiInputImage> {
  try {
    const { buffer, mimeType } = await downloadPinnedImage(value);
    return { imageBytes: buffer.toString('base64'), mimeType };
  } catch (error) {
    if (error instanceof MediaRequestError) throw error;
    throw new MediaRequestError('Video input image download failed or exceeded the size limit', 400);
  }
}

export async function prepareGeminiVideo(body: VideoRequestBody): Promise<GeminiPreparedVideo> {
  apiKey();
  const model = body.model?.trim() || getGeminiVideoModel();
  if (model !== GEMINI_VIDEO_DEFAULT_MODEL) throw new MediaRequestError('Selected Gemini video model is not supported by this integration', 400);
  const duration = body.duration_seconds ?? 8;
  const ratio = body.aspect_ratio ?? '16:9';
  const resolution = body.resolution ?? '720p';
  if (!Number.isInteger(duration) || duration < 3 || duration > 15) {
    throw new MediaRequestError('Gemini Omni video duration_seconds must be a whole second from 3 to 15', 400);
  }
  if (!['16:9', '9:16'].includes(ratio)) throw new MediaRequestError('Gemini video aspect_ratio must be 16:9 or 9:16', 400);
  if (!['720p', '1080p'].includes(resolution)) throw new MediaRequestError('Gemini video resolution must be 720p or 1080p', 400);
  if (body.quality !== undefined) throw new MediaRequestError('Use resolution and model instead of legacy video quality', 400);
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new MediaRequestError('Video prompt is required', 400);
  const refs = body.reference_images ?? [];
  if (!Array.isArray(refs) || refs.length > 6 || refs.some(ref => typeof ref !== 'string' || !ref)) {
    throw new MediaRequestError('Gemini Omni video supports at most 6 reference image URLs', 400);
  }
  if (refs.length && (body.first_frame_url || body.last_frame_url)) throw new MediaRequestError('Gemini references cannot be combined with explicit frames', 400);
  if (body.last_frame_url && (!body.first_frame_url || duration > 10)) throw new MediaRequestError('Gemini Omni last frame requires a first frame and at most 10 seconds', 400);
  const input: NonNullable<GeminiPreparedVideo['omniInput']> = [];
  for (const url of refs.length ? refs : [body.first_frame_url, body.last_frame_url].filter((value): value is string => Boolean(value))) {
    const image = await downloadImage(url);
    input.push({ type: 'image', data: image.imageBytes, mime_type: image.mimeType });
  }
  input.push({ type: 'text', text: body.prompt });
  return { model, prompt: body.prompt, duration, aspect_ratio: ratio, resolution, geminiConfig: {}, omniInput: input,
    ...(refs.length ? { omniTask: 'reference_to_video' as const } : body.first_frame_url && !body.last_frame_url ? { omniTask: 'image_to_video' as const } : {}) };
}

export async function submitGeminiVideo(prepared: GeminiPreparedVideo): Promise<OpenRouterVideoJob> {
  if (prepared.model !== GEMINI_VIDEO_DEFAULT_MODEL) throw new MediaRequestError('Selected Gemini video model is not supported by this integration', 400);
  const interaction = await interactionRequest(undefined, {
    model: prepared.model, input: prepared.omniInput ?? prepared.prompt,
    background: true, store: true, stream: false,
    response_format: { type: 'video', duration: `${prepared.duration}s`, aspect_ratio: prepared.aspect_ratio, resolution: prepared.resolution ?? '720p' },
    ...(prepared.omniTask ? { generation_config: { video_config: { task: prepared.omniTask } } } : {}),
  });
  return interactionJob(interaction);
}

export async function pollGeminiVideo(id: string): Promise<OpenRouterVideoJob> {
  return interactionJob(await interactionRequest(id), id);
}

export async function downloadGeminiVideo(id: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const interaction = await interactionRequest(id);
  if (interactionJob(interaction, id).status !== 'completed') throw new MediaRequestError('Gemini video is not completed');
  const video = interactionVideo(interaction);
  if (video?.mime_type && video.mime_type !== 'video/mp4') throw new MediaRequestError('Gemini returned unsupported video content');
  const data = video?.data;
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(100 * 1024 * 1024 / 3) * 4
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new MediaRequestError('Gemini returned invalid or oversized video data');
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > 100 * 1024 * 1024 || buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp'
    || buffer.toString('base64') !== data) throw new MediaRequestError('Gemini returned invalid video content');
  return { buffer, mimeType: 'video/mp4' };
}

interface OmniInteraction {
  id: string;
  status: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; mime_type?: string }> }>;
}

// output_video is SDK-only. Raw Interactions REST returns model_output steps.
function interactionVideo(interaction: OmniInteraction) {
  if (!Array.isArray(interaction.steps)) return undefined;
  for (const step of interaction.steps) {
    if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
    const video = step.content.find(content => content?.type === 'video');
    if (video) return video;
  }
  return undefined;
}

// SDK 1.25 has no Interactions API (requires 2.3+). Use the documented REST
// equivalent for the currently supported model without upgrading dependencies.
// https://aistudio.google.com/docs/omni
// https://aistudio.google.com/api-reference/interactions-api
async function interactionRequest(id?: string, body?: unknown): Promise<OmniInteraction> {
  const key = apiKey();
  if (body === undefined && (typeof id !== 'string' || !/^interactions\/[a-zA-Z0-9_-]{1,200}$/.test(id))) throw new MediaRequestError('Invalid Gemini video interaction ID');
  try {
    // No retries even for transport errors: background submit may be accepted.
    const response = await fetch(`${GOOGLE_ORIGIN}/v1beta/${id ?? 'interactions'}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(body === undefined ? 60_000 : 30_000),
    });
    if (!response.ok) throw new MediaRequestError(`Gemini video request failed (${response.status})`,
      response.status);
    return JSON.parse((await readResponseWithLimit(response, 140 * 1024 * 1024)).toString('utf8')) as OmniInteraction;
  } catch (error) {
    if (error instanceof MediaRequestError) throw error;
    throw new MediaRequestError(body === undefined ? 'Gemini video polling failed or returned invalid content' : 'Gemini video submission failed or timed out');
  }
}

function interactionJob(interaction: OmniInteraction, expectedId?: string): OpenRouterVideoJob {
  if (!interaction || typeof interaction.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(interaction.id)
    || !['in_progress', 'completed', 'failed', 'cancelled', 'incomplete', 'requires_action', 'requires_continuation'].includes(interaction.status)) {
    throw new MediaRequestError('Gemini returned an invalid video interaction');
  }
  const id = `interactions/${interaction.id}`;
  if (expectedId && expectedId !== id) throw new MediaRequestError('Gemini returned a mismatched video interaction');
  const video = interactionVideo(interaction);
  return { id, status: interaction.status === 'in_progress' ? 'in_progress'
    : interaction.status === 'completed' && typeof video?.data === 'string' && video.data.length ? 'completed' : 'failed' };
}
