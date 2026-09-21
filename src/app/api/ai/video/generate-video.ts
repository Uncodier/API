import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import { convertUrlToBase64, sleep } from './utils';
import { persistGeneratedVideo } from './video-storage';
import type {
  VideoAspectRatio,
  VideoGenerationResult,
  VideoQuality,
} from './video-types';

const DEFAULT_MODEL = 'veo-3.1-generate-preview';
const POLL_INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 10 * 60 * 1_000;

export function normalizeVideoDuration(value: number | undefined): 4 | 6 | 8 {
  if (value === undefined || value <= 4) return 4;
  if (value <= 6) return 6;
  return 8;
}

function geminiAspectRatio(
  value: VideoAspectRatio | undefined,
): '16:9' | '9:16' {
  return value === '9:16' ? '9:16' : '16:9';
}

function resolution(
  quality: VideoQuality | undefined,
  duration: number,
  aspectRatio: string,
): '720p' | '1080p' {
  return quality === 'pro' && duration === 8 && aspectRatio === '16:9'
    ? '1080p'
    : '720p';
}

async function downloadGeneratedVideo(
  ai: GoogleGenAI,
  video: any,
  apiKey: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const tempPath = path.join(
    os.tmpdir(),
    `gemini-video-${Date.now()}-${crypto.randomUUID()}.mp4`,
  );
  try {
    await ai.files.download({ file: video, downloadPath: tempPath });
    const stats = await fs.stat(tempPath);
    if (stats.size > 100 * 1024 * 1024) {
      throw new Error('Generated video exceeds 100 MB');
    }
    const buffer = await fs.readFile(tempPath);
    if (buffer.length > 0) {
      return { buffer, mimeType: video.mimeType || 'video/mp4' };
    }
  } catch (error) {
    console.warn('[Video API] SDK download failed:', error);
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }

  if (!video.uri) throw new Error('Gemini returned no downloadable video');
  const safeUrl = await assertSafeRemoteUrl(video.uri);
  safeUrl.searchParams.set('key', apiKey);
  const response = await fetch(safeUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) {
    throw new Error(`Gemini video download failed: ${response.status}`);
  }
  return {
    buffer: await readResponseWithLimit(response, 100 * 1024 * 1024),
    mimeType: response.headers.get('content-type') || 'video/mp4',
  };
}

export async function generateVideoWithGemini(options: {
  prompt: string;
  siteId: string;
  instanceId?: string;
  aspectRatio?: VideoAspectRatio;
  durationSeconds?: number;
  referenceImages?: string[];
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  quality?: VideoQuality;
  model?: string;
}): Promise<VideoGenerationResult> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
  const model =
    options.model || process.env.GOOGLE_CLOUD_VIDEOS_MODEL || DEFAULT_MODEL;
  if (!apiKey) throw new Error('Gemini video generation is not configured');

  const duration = options.lastFrameUrl
    ? 8
    : normalizeVideoDuration(options.durationSeconds);
  const aspectRatio = geminiAspectRatio(options.aspectRatio);
  const videoResolution = resolution(options.quality, duration, aspectRatio);
  const firstFrameUrl = options.firstFrameUrl ?? options.referenceImages?.[0];
  const [firstFrame, lastFrame] = await Promise.all([
    firstFrameUrl ? convertUrlToBase64(firstFrameUrl) : null,
    options.lastFrameUrl ? convertUrlToBase64(options.lastFrameUrl) : null,
  ]);
  if (firstFrameUrl && !firstFrame) {
    throw new Error('Unable to load the requested first frame');
  }
  if (options.lastFrameUrl && !lastFrame) {
    throw new Error('Unable to load the requested last frame');
  }
  const ai = new GoogleGenAI({ apiKey });
  let operation: any = await ai.models.generateVideos({
    model,
    prompt: [
      options.prompt,
      `Aspect ratio: ${aspectRatio}.`,
      `Target duration: ${duration} seconds.`,
      `Quality preference: ${options.quality || 'standard'}.`,
    ].join('\n'),
    config: {
      aspectRatio,
      resolution: videoResolution,
      durationSeconds: duration,
      ...(lastFrame
        ? {
            lastFrame: {
              imageBytes: lastFrame.data,
              mimeType: lastFrame.mimeType,
            },
          }
        : {}),
    },
    ...(firstFrame
      ? {
          image: {
            imageBytes: firstFrame.data,
            mimeType: firstFrame.mimeType,
          },
        }
      : {}),
  });

  const startedAt = Date.now();
  while (!operation?.done) {
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      throw new Error('Gemini video generation timed out');
    }
    await sleep(POLL_INTERVAL_MS);
    operation = await ai.operations.getVideosOperation({ operation });
  }
  if (operation?.error) {
    throw new Error(operation.error.message || 'Gemini video generation failed');
  }

  const video = operation?.response?.generatedVideos?.[0]?.video;
  if (!video) throw new Error('Gemini returned no video');
  const downloaded = await downloadGeneratedVideo(ai, video, apiKey);
  const persisted = await persistGeneratedVideo({
    ...downloaded,
    siteId: options.siteId,
    prompt: options.prompt,
    model,
    instanceId: options.instanceId,
    metadata: {
      duration_seconds: duration,
      aspect_ratio: aspectRatio,
      quality: options.quality,
      resolution: videoResolution,
      requested_duration_seconds: options.durationSeconds,
      requested_aspect_ratio: options.aspectRatio,
    },
  });

  return {
    provider: 'gemini',
    videos: [persisted],
    metadata: {
      model,
      duration_seconds: duration,
      aspect_ratio: aspectRatio,
      quality: options.quality,
      resolution: videoResolution,
      generated_at: new Date().toISOString(),
    },
  };
}
