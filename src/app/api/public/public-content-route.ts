import { NextRequest, NextResponse } from 'next/server';
import {
  CONTENT_TYPES,
  getContents,
  type ContentType,
  type DbContentWithAssets,
} from '@/lib/database/content-db';
import {
  hasExplicitPublicSiteContext,
  resolvePublicSiteContext,
} from '@/lib/security/public-site-context';

const contentTypes = new Set<string>(CONTENT_TYPES);
const publicMetadataKeys = new Set([
  'url',
  'slug',
  'excerpt',
  'canonical_url',
  'image_url',
  'thumbnail_url',
  'duration',
]);

function publicMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) return null;
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => publicMetadataKeys.has(key)),
  );
}

function publicContent(content: DbContentWithAssets) {
  return {
    id: content.id,
    title: content.title,
    description: content.description,
    type: content.type,
    text: content.text,
    tags: content.tags,
    estimated_reading_time: content.estimated_reading_time,
    created_at: content.created_at,
    updated_at: content.updated_at,
    published_at: content.published_at,
    metadata: publicMetadata(content.metadata),
    assets: (content.assets ?? []).map((asset) => ({
      id: asset.id,
      name: asset.name,
      description: asset.description,
      file_path: asset.file_path,
      file_type: asset.file_type,
      position: asset.position,
      is_primary: asset.is_primary,
    })),
  };
}

function integerParam(
  request: NextRequest,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = request.nextUrl.searchParams.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : fallback;
}

export function createPublicContentGet(fixedType?: ContentType) {
  return async function GET(request: NextRequest) {
    try {
      const site = await resolvePublicSiteContext(request);
      if (!site) {
        return NextResponse.json(
          { success: false, error: 'Site not found' },
          { status: 404 },
        );
      }

      const requestedType = request.nextUrl.searchParams.get('type');
      if (!fixedType && requestedType && !contentTypes.has(requestedType)) {
        return NextResponse.json(
          { success: false, error: 'Invalid content type' },
          { status: 400 },
        );
      }
      const search = request.nextUrl.searchParams.get('search')?.trim();
      if (search && search.length < 3) {
        return NextResponse.json(
          { success: false, error: 'Search must contain at least 3 characters' },
          { status: 400 },
        );
      }

      const result = await getContents({
        site_id: site.id,
        type: fixedType || (requestedType as ContentType | null) || undefined,
        status: 'published',
        search: search || undefined,
        limit: Math.max(1, integerParam(request, 'limit', 50, 100)),
        offset: integerParam(request, 'offset', 0, 10_000),
        exact_count: false,
        full_text_search: true,
        public_projection: true,
      });
      const publicContents = result.contents.map(publicContent);
      const response = NextResponse.json({
        success: true,
        data: publicContents,
        total: result.total,
        has_more: result.hasMore,
        site,
      });
      response.headers.set(
        'Cache-Control',
        hasExplicitPublicSiteContext(request)
          ? 'public, s-maxage=30, stale-while-revalidate=60'
          : 'private, no-store',
      );
      return response;
    } catch (error) {
      console.error('[Public Content] Request failed:', error);
      return NextResponse.json(
        { success: false, error: 'Internal Server Error' },
        { status: 500 },
      );
    }
  };
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
