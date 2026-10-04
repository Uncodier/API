import { NextRequest, NextResponse } from 'next/server';
import { CreditService } from '@/lib/services/billing/CreditService';
import {
  enforceRequestRateLimit,
  getAuthenticatedRateIdentity,
  isInternalServiceRequest,
} from '@/lib/security/request-rate-limit';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { canAccessSite } from '@/lib/security/site-access';
import type { ImageRequestBody } from './image-types';
import { generateWithAzure } from './provider-azure';
import { MediaRequestError } from '@/lib/services/image/media-request-error';
import { mediaInstanceBelongsToSite } from '@/lib/services/ai/media-instance-access';

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

export async function POST(request: NextRequest) {
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
    if (!await mediaInstanceBelongsToSite(body.site_id, body.instance_id)) {
      return NextResponse.json({ error: 'Instance does not belong to the authorized site' }, { status: 403 });
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

    const count = body.n ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 4) {
      return NextResponse.json({ error: 'n must be an integer between 1 and 4' }, { status: 400 });
    }
    const provider = body.provider ?? 'azure';
    if (provider !== 'azure') {
      return NextResponse.json({ error: 'Unsupported image provider' }, { status: 400 });
    }
    if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
      return NextResponse.json({ error: 'model must be a nonempty string' }, { status: 400 });
    }

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

    const result = await generateWithAzure({
      prompt: body.prompt,
      siteId: body.site_id,
      instanceId: body.instance_id,
      size: body.size,
      count,
      quality: body.quality,
      ratio: body.aspect_ratio || body.ratio,
      referenceImages,
      model: body.model,
    });
    if (!systemRequest) {
      const deduction = await CreditService.deductCredits(
        body.site_id,
        CreditService.PRICING.IMAGE_GENERATION * result.images.length,
        'image_generation',
        `Image generation (${result.images.length} images)`,
        { prompt: body.prompt, provider, ...result.metadata },
      );
      if (!deduction.success) {
        throw new Error(deduction.error || 'Unable to deduct image credits');
      }
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof MediaRequestError ? error.message : 'Image generation failed' },
      { status: error instanceof MediaRequestError ? error.status : 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Image Generation API',
    providers: ['azure'],
    default_provider: 'azure',
  });
}
