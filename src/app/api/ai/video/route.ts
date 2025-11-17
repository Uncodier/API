import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { bufferFromDownload, convertUrlToBase64, sleep } from './utils';

type Provider = 'gemini';
type AspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
type VideoQuality = 'preview' | 'standard' | 'pro';
interface VideoRequestBody {
  prompt: string;
  site_id: string;
  provider?: Provider;
  duration_seconds?: number;
  aspect_ratio?: AspectRatio;
  reference_images?: string[];
  quality?: VideoQuality;
  model?: string;
}
interface VideoGenerationResult {
  provider: Provider;
  videos: Array<{ url: string; mimeType: string }>;
  metadata: {
    model: string;
    duration_seconds?: number;
    aspect_ratio?: AspectRatio;
    quality?: VideoQuality;
    generated_at: string;
    fallbackFrom?: Provider;
  };
}

const DEFAULT_VIDEO_MODEL = 'veo-3.1-generate-preview';
const VIDEO_BUCKET = 'generative_videos';
const MAX_REFERENCE_IMAGES = 3;
const MAX_DURATION_SECONDS = 60;
const POLL_INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes
function getEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[video api] Missing environment variable ${name}`);
  }
  return value;
}
async function uploadVideoToStorage(
  buffer: Buffer,
  mimeType: string,
  siteId: string,
  provider: string,
  prompt: string
): Promise<{ path: string; url: string; size: number; mimeType: string }> {
  try {
    let ext = 'mp4';
    if (mimeType.includes('webm')) {
      ext = 'webm';
    } else if (mimeType.includes('mov')) {
      ext = 'mov';
    }

    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).slice(2, 8);
    const path = `${siteId}/${timestamp}-${randomSuffix}.${ext}`;

    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from(VIDEO_BUCKET)
      .upload(path, buffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (uploadError || !uploadData?.path) {
      throw new Error(uploadError?.message || 'Unknown storage upload error');
    }

    const { data: urlData } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(path);
    let url = urlData?.publicUrl || '';

    if (!url) {
      const { data: signedData, error: signError } = await supabaseAdmin.storage
        .from(VIDEO_BUCKET)
        .createSignedUrl(path, 60 * 60 * 24 * 7);

      if (signError || !signedData?.signedUrl) {
        throw new Error(signError?.message || 'Failed to create signed URL');
      }

      url = signedData.signedUrl;
    }

    return {
      path: uploadData.path,
      url,
      size: buffer.length,
      mimeType,
    };
  } catch (error: any) {
    console.error('[Video Storage] Upload error:', error);
    throw new Error(`Failed to upload video to storage: ${error.message || error}`);
  }
}

async function saveFileRecord(
  siteId: string,
  path: string,
  url: string,
  size: number,
  mimeType: string,
  provider: string,
  prompt: string,
  model: string,
  metadata: Record<string, unknown>,
  userId?: string
) {
  try {
    let ownerUserId = userId;

    if (!ownerUserId) {
      const { data: ownershipData, error: ownershipError } = await supabaseAdmin
        .from('site_ownership')
        .select('user_id')
        .eq('site_id', siteId)
        .single();

      if (ownershipError) {
        console.warn('[Video File Record] Could not resolve site owner:', ownershipError.message);
      } else {
        ownerUserId = ownershipData?.user_id;
      }
    }

    const filename = `${provider}_video_${Date.now()}.${mimeType.split('/')[1] || 'mp4'}`;

    const insertData: any = {
      site_id: siteId,
      name: filename,
      file_path: url,
      file_type: mimeType,
      file_size: size,
      metadata: {
        provider,
        prompt,
        generated_at: new Date().toISOString(),
        model,
        storage_path: path,
        bucket: VIDEO_BUCKET,
        ...metadata,
      },
      is_public: true,
    };

    if (ownerUserId) {
      insertData.user_id = ownerUserId;
    }

    const { error: insertError } = await supabaseAdmin.from('assets').insert(insertData);

    if (insertError) {
      throw new Error(insertError.message || 'Unknown database error');
    }
  } catch (error: any) {
    console.warn('[Video File Record] Save error:', error.message || error);
    throw error;
  }
}

function buildPrompt(prompt: string, aspectRatio?: AspectRatio, durationSeconds?: number, quality?: VideoQuality) {
  const hints: string[] = [];

  if (aspectRatio) {
    hints.push(`Aspect ratio: ${aspectRatio}.`);
  }

  if (durationSeconds) {
    hints.push(`Target duration: approximately ${durationSeconds} seconds.`);
  }

  if (quality) {
    hints.push(`Quality preference: ${quality}.`);
  }

  if (!hints.length) {
    return prompt;
  }

  return `${prompt}\n\n${hints.join(' ')}`;
}

async function generateWithGemini(options: {
  prompt: string;
  siteId: string;
  aspectRatio?: AspectRatio;
  durationSeconds?: number;
  referenceImages?: string[];
  quality?: VideoQuality;
  model?: string;
}): Promise<VideoGenerationResult> {
  const apiKey = getEnv('GEMINI_API_KEY') || getEnv('GOOGLE_CLOUD_API_KEY');
  const model = options.model || getEnv('GOOGLE_CLOUD_VIDEOS_MODEL') || DEFAULT_VIDEO_MODEL;

  if (!apiKey) {
    throw new Error('Gemini API key is not configured. Set GEMINI_API_KEY or GOOGLE_CLOUD_API_KEY.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const finalPrompt = buildPrompt(options.prompt, options.aspectRatio, options.durationSeconds, options.quality);

  const references: Array<{ data: string; mimeType: string }> = [];
  for (const url of options.referenceImages?.slice(0, MAX_REFERENCE_IMAGES) || []) {
    const converted = await convertUrlToBase64(url);
    if (converted) {
      references.push(converted);
    }
  }

  console.log('[Gemini Video] Starting generation', {
    model,
    siteId: options.siteId,
    aspectRatio: options.aspectRatio,
    durationSeconds: options.durationSeconds,
    references: references.length,
  });

  let operation: any = await ai.models.generateVideos({
    model,
    prompt: finalPrompt,
    ...(references[0]
      ? {
          image: {
            imageBytes: references[0].data,
            mimeType: references[0].mimeType,
          },
        }
      : {}),
  });

  const startTime = Date.now();

  while (!operation?.done) {
    if (Date.now() - startTime > MAX_WAIT_MS) {
      throw new Error('Gemini video generation timed out after 10 minutes.');
    }

    await sleep(POLL_INTERVAL_MS);
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const operationError = (operation as any)?.error;
  if (operationError) {
    const errorMessage =
      typeof operationError.message === 'string' && operationError.message.length > 0
        ? operationError.message
        : 'Gemini video generation failed.';
    throw new Error(errorMessage);
  }

  const generatedVideo = operation?.response?.generatedVideos?.[0];
  console.log('[Gemini Video] Operation finished', {
    videosCount: operation?.response?.generatedVideos?.length || 0,
    hasVideo: Boolean(generatedVideo?.video),
    videoMeta: generatedVideo?.video
      ? {
          name: (generatedVideo.video as any)?.name,
          uri: (generatedVideo.video as any)?.uri,
          mimeType: generatedVideo.video.mimeType,
        }
      : null,
  });
  console.log('[Gemini Video] Raw operation payload:', JSON.stringify(operation, null, 2));

  if (!generatedVideo?.video) {
    throw new Error('Gemini video generation did not return any video data.');
  }

  const videoUri = (generatedVideo.video as any)?.uri;
  console.log('[Gemini Video] Downloading video payload', {
    hasUri: Boolean(videoUri),
    hasName: Boolean((generatedVideo.video as any)?.name),
    mimeType: generatedVideo.video?.mimeType,
  });

  let videoBuffer: Buffer | null = null;
  let mimeType = generatedVideo.video?.mimeType || 'video/mp4';

  // Try SDK download exactly as docs suggest (write to temp file)
  const tmpFilePath = path.join(os.tmpdir(), `gemini-video-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  try {
    await ai.files.download({
      file: generatedVideo.video,
      downloadPath: tmpFilePath,
    });
    const fileData = await fs.readFile(tmpFilePath).catch(() => null);
    await fs.unlink(tmpFilePath).catch(() => {});
    if (fileData && fileData.length > 0) {
      videoBuffer = fileData;
      console.log('[Gemini Video] SDK download completed', {
        size: videoBuffer.length,
      });
    } else {
      console.warn('[Gemini Video] SDK download appeared empty after read, falling back to signed URI');
    }
  } catch (sdkErr) {
    console.warn('[Gemini Video] SDK download failed, falling back to signed URI', sdkErr);
    await fs.unlink(tmpFilePath).catch(() => {});
  }

  if (!videoBuffer && videoUri) {
    const downloadResp = await fetch(`${videoUri}&key=${apiKey}`, {
      signal: AbortSignal.timeout(240_000),
    });

    if (!downloadResp.ok) {
      const errorBody = await downloadResp.text().catch(() => '');
      throw new Error(`Gemini video download failed: ${downloadResp.status} ${downloadResp.statusText} ${errorBody}`);
    }

    const arr = await downloadResp.arrayBuffer();
    videoBuffer = Buffer.from(arr);
    mimeType = downloadResp.headers.get('content-type') || mimeType;
    console.log('[Gemini Video] Downloaded via signed URI', {
      size: videoBuffer.length,
      mimeType,
    });
  }

  if (!videoBuffer) {
    throw new Error('Gemini video download produced an empty buffer.');
  }

  const uploadResult = await uploadVideoToStorage(videoBuffer, mimeType, options.siteId, 'gemini', options.prompt);

  try {
    await saveFileRecord(
      options.siteId,
      uploadResult.path,
      uploadResult.url,
      uploadResult.size,
      uploadResult.mimeType,
      'gemini',
      options.prompt,
      model,
      {
        duration_seconds: options.durationSeconds,
        aspect_ratio: options.aspectRatio,
        quality: options.quality,
      }
    );
  } catch (error) {
    console.warn('[Gemini Video] Failed to save file record:', (error as Error).message);
  }

  return {
    provider: 'gemini',
    videos: [
      {
        url: uploadResult.url,
        mimeType: uploadResult.mimeType,
      },
    ],
    metadata: {
      model,
      duration_seconds: options.durationSeconds,
      aspect_ratio: options.aspectRatio,
      quality: options.quality,
      generated_at: new Date().toISOString(),
    },
  };
}

function isValidUUID(value: string) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

function isValidUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as VideoRequestBody | null;
    const {
      prompt,
      site_id,
      provider = 'gemini',
      duration_seconds,
      aspect_ratio,
      reference_images,
      quality,
      model,
    } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Parameter "prompt" is required' }, { status: 400 });
    }

    if (!site_id || typeof site_id !== 'string') {
      return NextResponse.json({ error: 'Parameter "site_id" is required' }, { status: 400 });
    }

    if (!isValidUUID(site_id)) {
      return NextResponse.json({ error: 'Parameter "site_id" must be a valid UUID' }, { status: 400 });
    }

    if (aspect_ratio && !['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'].includes(aspect_ratio)) {
      return NextResponse.json({ error: 'Invalid aspect_ratio value' }, { status: 400 });
    }

    if (duration_seconds !== undefined) {
      if (typeof duration_seconds !== 'number' || Number.isNaN(duration_seconds) || duration_seconds <= 0) {
        return NextResponse.json({ error: 'Parameter "duration_seconds" must be a positive number' }, { status: 400 });
      }
    }

    if (reference_images !== undefined) {
      if (!Array.isArray(reference_images)) {
        return NextResponse.json({ error: 'Parameter "reference_images" must be an array of URLs' }, { status: 400 });
      }

      if (reference_images.length > MAX_REFERENCE_IMAGES) {
        return NextResponse.json(
          { error: `A maximum of ${MAX_REFERENCE_IMAGES} reference_images are supported` },
          { status: 400 }
        );
      }

      for (const url of reference_images) {
        if (typeof url !== 'string' || !isValidUrl(url)) {
          return NextResponse.json({ error: 'All reference_images must be valid HTTP/HTTPS URLs' }, { status: 400 });
        }
      }
    }

    if (provider !== 'gemini') {
      return NextResponse.json({ error: `Unsupported provider: ${provider}` }, { status: 400 });
    }

    const sanitizedDuration =
      typeof duration_seconds === 'number'
        ? Math.min(Math.round(duration_seconds), MAX_DURATION_SECONDS)
        : undefined;

    const result = await generateWithGemini({
      prompt,
      siteId: site_id,
      aspectRatio: aspect_ratio,
      durationSeconds: sanitizedDuration,
      referenceImages: reference_images,
      quality,
      model,
    });

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[video api] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to process request' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Video Generation API',
    usage: {
      method: 'POST',
      body: {
        prompt: 'string (required)',
        site_id: 'string (required) - UUID of the site',
        provider: "'gemini' (default)",
        duration_seconds: 'number (optional, max 60)',
        aspect_ratio: "'1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3'",
        reference_images: 'string[] (optional, max 3)',
        quality: "'preview' | 'standard' | 'pro'",
      },
    },
    providers: ['gemini'],
    env: {
      required: ['GEMINI_API_KEY or GOOGLE_CLOUD_API_KEY'],
      optional: ['GOOGLE_CLOUD_VIDEOS_MODEL (default: veo-3.1-generate-preview)'],
    },
    notes: {
      generation: 'Video generation is asynchronous. The API polls Gemini every 10 seconds (max 10 minutes).',
      storage: `Videos are uploaded to Supabase Storage bucket "${VIDEO_BUCKET}" and asset records are created automatically.`,
      references: `You can supply up to ${MAX_REFERENCE_IMAGES} reference images via publicly accessible URLs.`,
    },
  });
}



