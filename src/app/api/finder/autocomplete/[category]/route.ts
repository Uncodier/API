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

    const accountId = process.env.FORAGER_ACCOUNT_ID;
    const apiKey = process.env.FORAGER_API_KEY;
    if (!accountId || !apiKey) {
      return NextResponse.json({ error: 'Finder autocomplete is not configured' }, { status: 503 });
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
    const upstreamUrl = `https://api-v2.forager.ai/api/${encodeURIComponent(accountId)}/datastorage/autocomplete/${encodeURIComponent(category)}/?${qs}`;

    const resp = await fetch(upstreamUrl, {
      method: 'GET',
      headers: { 'X-API-KEY': apiKey },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    const contentType = resp.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    

    if (!resp.ok) {
      logError('API:finder-autocomplete', 'Upstream error', {
        status: resp.status,
        contentType,
        params: { category, q, page },
      });
      return NextResponse.json(
        { error: 'Search service temporarily unavailable' },
        { status: 502 }
      );
    }

    if (!isJson) return NextResponse.json({ error: 'Invalid autocomplete response' }, { status: 502 });
    const data = await resp.json();
    if (!data || !Array.isArray(data.results)) {
      return NextResponse.json({ error: 'Invalid autocomplete response' }, { status: 502 });
    }
    return NextResponse.json(data);
  } catch (error: unknown) {
    logError('API:finder-autocomplete', 'Handler exception', { type: error instanceof Error ? error.name : 'Unknown error' });
    return NextResponse.json({ error: 'Finder autocomplete is temporarily unavailable' }, { status: 502 });
  }
}

export const dynamic = 'force-dynamic';


