import { NextRequest, NextResponse } from 'next/server';
import { CreditService } from '@/lib/services/billing/CreditService';
import {
  enforceRequestRateLimit,
  getAuthenticatedRateIdentity,
  isInternalServiceRequest,
} from '@/lib/security/request-rate-limit';
import {
  acquireLock,
  releaseLock,
  sha256,
} from '@/lib/security/upstash-rest';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { canAccessSite } from '@/lib/security/site-access';
import type {
  GenerateImageOptions,
  ImageGenerationResult,
  ImageProvider,
  ImageRequestBody,
} from './image-types';
import { generateWithAzure } from './provider-azure';
import { generateWithGemini } from './provider-gemini';
import { generateWithVercelGateway } from './provider-vercel';

const SYSTEM_SITE_ID = '00000000-0000-0000-0000-000000000000';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function validateReferenceImages(
  values: unknown,
): Promise<string[] | undefined> {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > 4) {
    throw new Error('reference_images must contain at most 4 URLs');
  }
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new Error('All reference_images must be HTTPS URLs');
    }
    await assertSafeRemoteUrl(value);
  }
  return values;
}

async function generate(
  provider: ImageProvider,
  options: GenerateImageOptions,
): Promise<ImageGenerationResult> {
  if (provider === 'vercel') return generateWithVercelGateway(options);
  if (provider === 'azure') {
    try {
      return await generateWithAzure(options);
    } catch (azureError) {
      const result = await generateWithGemini(options);
      result.fallbackFrom = 'azure';
      console.warn('[Image API] Azure failed; Gemini fallback succeeded:', azureError);
      return result;
    }
  }
  try {
    return await generateWithGemini(options);
  } catch (geminiError) {
    const result = await generateWithAzure(options);
    result.fallbackFrom = 'gemini';
    console.warn('[Image API] Gemini failed; Azure fallback succeeded:', geminiError);
    return result;
  }
}

export async function POST(request: NextRequest) {
  let generationLock: { key: string; token: string } | null = null;
  try {
    const identity = getAuthenticatedRateIdentity(request);
    const internal = isInternalServiceRequest(request);
    const limited = await enforceRequestRateLimit(request, {
      namespace: 'ai-image-principal',
      identity,
      limit: internal ? 120 : 10,
      windowSeconds: 60,
      failClosed: true,
    });
    if (limited) return limited;

    const body = await request.json() as ImageRequestBody;
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
      return NextResponse.json(
        { error: 'site_id must be a valid UUID' },
        { status: 400 },
      );
    }

    const systemRequest = body.site_id === SYSTEM_SITE_ID;
    if (systemRequest ? !internal : !await canAccessSite(request, body.site_id)) {
      return NextResponse.json({ error: 'Site access denied' }, { status: 403 });
    }

    let referenceImages: string[] | undefined;
    try {
      referenceImages = await validateReferenceImages(body.reference_images);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invalid reference image' },
        { status: 400 },
      );
    }

    const parsedCount = Number(body.n);
    const count = Number.isFinite(parsedCount)
      ? Math.min(4, Math.max(1, Math.trunc(parsedCount)))
      : 1;
    const provider: ImageProvider = ['azure', 'gemini', 'vercel'].includes(
      body.provider || '',
    )
      ? body.provider as ImageProvider
      : 'gemini';
    const lockKey = `lock:ai-image:${await sha256(body.site_id)}`;
    const lock = await acquireLock(lockKey, 120);
    if (lock.state === 'contended') {
      return NextResponse.json(
        { error: 'Another image generation is already running' },
        { status: 409, headers: { 'Retry-After': '5' } },
      );
    }
    if (lock.state !== 'acquired') {
      return NextResponse.json(
        { error: 'Image generation admission is unavailable' },
        { status: 503, headers: { 'Retry-After': '5' } },
      );
    }
    generationLock = { key: lockKey, token: lock.token };

    const requiredCredits = CreditService.PRICING.IMAGE_GENERATION * count;
    if (!systemRequest && !await CreditService.validateCredits(
      body.site_id,
      requiredCredits,
    )) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: 'Insufficient credits for image generation',
          },
        },
        { status: 402 },
      );
    }

    const result = await generate(provider, {
      prompt: body.prompt,
      siteId: body.site_id,
      instanceId: body.instance_id,
      size: body.size,
      count,
      quality: body.quality,
      ratio: body.aspect_ratio || body.ratio,
      referenceImages,
    });
    if (!systemRequest) {
      const deduction = await CreditService.deductCredits(
        body.site_id,
        CreditService.PRICING.IMAGE_GENERATION * result.images.length,
        'image_generation',
        `Image generation (${result.images.length} images)`,
        { prompt: body.prompt, provider },
      );
      if (!deduction.success) {
        throw new Error(deduction.error || 'Unable to deduct image credits');
      }
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('[Image API] Request failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Image generation failed' },
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
    message: 'AI Image Generation API',
    providers: ['azure', 'gemini', 'vercel'],
  });
}
