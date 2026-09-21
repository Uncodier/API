import { NextRequest, NextResponse } from 'next/server';
import {
  hasAuthenticatedPrincipal,
} from '@/lib/security/request-rate-limit';
import { canAccessSite } from '@/lib/security/site-access';
import {
  issuePublicImageSignature,
} from '@/lib/security/public-image-signature';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SignImageBody {
  site_id?: unknown;
  prompt?: unknown;
  width?: unknown;
  height?: unknown;
  ttl_seconds?: unknown;
}

function positiveDimension(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function POST(request: NextRequest) {
  if (!hasAuthenticatedPrincipal(request)) {
    return NextResponse.json(
      { error: 'Authentication is required to sign image generation URLs' },
      { status: 401 },
    );
  }

  let body: SignImageBody;
  try {
    body = await request.json() as SignImageBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.site_id !== 'string' || !UUID_PATTERN.test(body.site_id)) {
    return NextResponse.json(
      { error: 'site_id must be a valid UUID' },
      { status: 400 },
    );
  }
  if (
    typeof body.prompt !== 'string'
    || body.prompt.trim().length === 0
    || body.prompt.length > 2_000
  ) {
    return NextResponse.json(
      { error: 'prompt must contain between 1 and 2000 characters' },
      { status: 400 },
    );
  }
  if (!await canAccessSite(request, body.site_id)) {
    return NextResponse.json({ error: 'Site access denied' }, { status: 403 });
  }

  const width = positiveDimension(body.width, 1024);
  const height = positiveDimension(body.height, 1024);
  const ttlSeconds = positiveDimension(body.ttl_seconds, 10 * 60);
  const issued = issuePublicImageSignature(
    {
      siteId: body.site_id,
      prompt: body.prompt,
      width,
      height,
    },
    ttlSeconds,
  );
  const url = new URL(
    `/api/public/image/prompt/${encodeURIComponent(body.prompt)}`,
    request.nextUrl.origin,
  );
  url.searchParams.set('site_id', body.site_id);
  url.searchParams.set('width', String(width));
  url.searchParams.set('height', String(height));
  url.searchParams.set('expires', String(issued.expires));
  url.searchParams.set('signature', issued.signature);

  return NextResponse.json(
    {
      url: url.toString(),
      expires_at: new Date(issued.expires * 1_000).toISOString(),
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
