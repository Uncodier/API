import { NextRequest, NextResponse } from 'next/server';
import { CreditService } from '@/lib/services/billing/CreditService';
import {
  enforceRequestRateLimit,
  getAuthenticatedRateIdentity,
  isInternalServiceRequest,
} from '@/lib/security/request-rate-limit';
import { canAccessSite } from '@/lib/security/site-access';
import {
  acquireLock,
  releaseLock,
  sha256,
} from '@/lib/security/upstash-rest';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import {
  generateVideoWithGemini,
  normalizeVideoDuration,
} from './generate-video';
import type { VideoRequestBody } from './video-types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_RATIOS = new Set(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']);

async function validateReferences(value: unknown): Promise<string[] | undefined> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) {
    throw new Error('reference_images must contain at most 3 URLs');
  }
  for (const url of value) {
    if (typeof url !== 'string') throw new Error('Invalid reference image URL');
    await assertSafeRemoteUrl(url);
  }
  return value;
}

async function validateFrameUrl(value: unknown, field: string): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a valid URL`);
  }
  await assertSafeRemoteUrl(value);
  return value;
}

export async function POST(request: NextRequest) {
  let generationLock: { key: string; token: string } | null = null;
  try {
    const identity = getAuthenticatedRateIdentity(request);
    const limited = await enforceRequestRateLimit(request, {
      namespace: 'ai-video-principal',
      identity,
      limit: isInternalServiceRequest(request) ? 30 : 3,
      windowSeconds: 60,
      failClosed: true,
    });
    if (limited) return limited;

    const body = await request.json() as VideoRequestBody;
    if (
      typeof body?.prompt !== 'string'
      || body.prompt.length === 0
      || body.prompt.length > 10_000
    ) {
      return NextResponse.json(
        { error: 'prompt must contain between 1 and 10000 characters' },
        { status: 400 },
      );
    }
    if (typeof body.site_id !== 'string' || !UUID_PATTERN.test(body.site_id)) {
      return NextResponse.json({ error: 'site_id must be a valid UUID' }, { status: 400 });
    }
    if (!await canAccessSite(request, body.site_id)) {
      return NextResponse.json({ error: 'Site access denied' }, { status: 403 });
    }
    if (body.provider && body.provider !== 'gemini') {
      return NextResponse.json({ error: 'Unsupported video provider' }, { status: 400 });
    }
    if (
      body.duration_seconds !== undefined
      && (
        !Number.isFinite(body.duration_seconds)
        || body.duration_seconds <= 0
        || body.duration_seconds > 60
      )
    ) {
      return NextResponse.json(
        { error: 'duration_seconds must be between 1 and 60' },
        { status: 400 },
      );
    }
    if (body.aspect_ratio && !VALID_RATIOS.has(body.aspect_ratio)) {
      return NextResponse.json({ error: 'Invalid aspect_ratio' }, { status: 400 });
    }

    let referenceImages: string[] | undefined;
    let firstFrameUrl: string | undefined;
    let lastFrameUrl: string | undefined;
    try {
      referenceImages = await validateReferences(body.reference_images);
      firstFrameUrl = await validateFrameUrl(body.first_frame_url, 'first_frame_url');
      lastFrameUrl = await validateFrameUrl(body.last_frame_url, 'last_frame_url');
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invalid reference image' },
        { status: 400 },
      );
    }
    if (lastFrameUrl && !firstFrameUrl && !referenceImages?.[0]) {
      return NextResponse.json(
        { error: 'last_frame_url requires first_frame_url or a reference image' },
        { status: 400 },
      );
    }

    const duration = lastFrameUrl ? 8 : normalizeVideoDuration(body.duration_seconds);
    const requiredCredits =
      (duration / 60) * CreditService.PRICING.VIDEO_GENERATION_MINUTE;
    if (!await CreditService.validateCredits(body.site_id, requiredCredits)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: 'Insufficient credits for video generation',
          },
        },
        { status: 402 },
      );
    }

    const lockKey = `lock:ai-video:${await sha256(body.site_id)}`;
    const lock = await acquireLock(lockKey, 11 * 60);
    if (lock.state === 'contended') {
      return NextResponse.json(
        { error: 'Another video generation is already running' },
        { status: 409, headers: { 'Retry-After': '10' } },
      );
    }
    if (lock.state !== 'acquired') {
      return NextResponse.json(
        { error: 'Video generation admission is unavailable' },
        { status: 503, headers: { 'Retry-After': '10' } },
      );
    }
    generationLock = { key: lockKey, token: lock.token };

    const result = await generateVideoWithGemini({
      prompt: body.prompt,
      siteId: body.site_id,
      instanceId: body.instance_id,
      aspectRatio: body.aspect_ratio,
      durationSeconds: duration,
      referenceImages,
      firstFrameUrl,
      lastFrameUrl,
      quality: body.quality,
      model: body.model,
    });
    const deduction = await CreditService.deductCredits(
      body.site_id,
      requiredCredits * result.videos.length,
      'video_generation',
      `Video generation (${result.videos.length} videos)`,
      { prompt: body.prompt, provider: 'gemini' },
    );
    if (!deduction.success) {
      throw new Error(deduction.error || 'Unable to deduct video credits');
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('[Video API] Request failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Video generation failed' },
      { status: 500 },
    );
  } finally {
    if (generationLock) {
      await releaseLock(generationLock.key, generationLock.token);
    }
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Video Generation API',
    providers: ['gemini'],
    duration_seconds: '1-60, normalized to a supported 4, 6, or 8 seconds',
  });
}
