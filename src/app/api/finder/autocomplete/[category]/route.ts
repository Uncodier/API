import { NextRequest, NextResponse } from 'next/server';
import { logInfo, logError } from '@/lib/utils/api-response-utils';

// Allowed autocomplete categories based on Forager docs/screenshot
// industries, organizations, organization_keywords, locations, person_skills, web_technologies
const ALLOWED_CATEGORIES = new Set([
  'industries',
  'organizations',
  'organization_keywords',
  'locations',
  'person_skills',
  'web_technologies'
]);

export async function GET(req: NextRequest, context: { params: Promise<{ category?: string }> }) {
  try {
    const { category: rawCategory } = await context.params;
    const category = (rawCategory || '').toLowerCase();
    if (!ALLOWED_CATEGORIES.has(category)) {
      return NextResponse.json(
        {
          error: 'Invalid category',
          allowed: Array.from(ALLOWED_CATEGORIES)
        },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q') || '';
    const pageRaw = searchParams.get('page');
    const page = pageRaw && /^\d+$/.test(pageRaw) ? Math.max(1, parseInt(pageRaw, 10)) : 1;

    const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '';
    logInfo('API:finder-autocomplete', 'GET query', { category, q, page, ip });

    

    const qs = new URLSearchParams([
      ['page', String(page)],
      ['q', q]
    ]).toString();
    const upstreamUrl = `https://api-v2.forager.ai/api/datastorage/autocomplete/${encodeURIComponent(category)}/?${qs}`;
    logInfo('API:finder-autocomplete', 'Upstream request', { upstreamUrl, params: { category, q, page } });

    const resp = await fetch(upstreamUrl, { method: 'GET' });
    const contentType = resp.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    

    if (!resp.ok) {
      const errorPayload = isJson
        ? await resp.json().catch(() => ({ message: 'Upstream error (invalid JSON)' }))
        : { message: await resp.text().catch(() => 'Upstream error' as const) };
      logError('API:finder-autocomplete', 'Upstream error', {
        status: resp.status,
        upstreamUrl,
        contentType,
        params: { category, q, page },
        error: errorPayload
      });
      return NextResponse.json(
        { error: 'Forager API error', details: errorPayload },
        { status: resp.status }
      );
    }

    const data = isJson ? await resp.json() : await resp.text();
    return NextResponse.json(typeof data === 'string' ? { data } : data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('API:finder-autocomplete', 'Handler exception', error instanceof Error ? { message: error.message, stack: error.stack } : error);
    return NextResponse.json({ error: 'Internal error', message }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';


