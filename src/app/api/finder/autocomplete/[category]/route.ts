import { NextRequest, NextResponse } from 'next/server';

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
    let page = searchParams.get('page') || '1';
    // Force page to be a positive integer starting at 1
    if (!/^[1-9]\d*$/.test(page)) {
      page = '1';
    }

    

    const qs = new URLSearchParams([
      ['page', page],
      ['q', q]
    ]).toString();
    const upstreamUrl = `https://api-v2.forager.ai/api/datastorage/autocomplete/${encodeURIComponent(category)}/?${qs}`;

    const resp = await fetch(upstreamUrl, { method: 'GET' });
    const contentType = resp.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    

    if (!resp.ok) {
      const errorPayload = isJson
        ? await resp.json().catch(() => ({ message: 'Upstream error (invalid JSON)' }))
        : { message: await resp.text().catch(() => 'Upstream error' as const) };
      return NextResponse.json(
        { error: 'Forager API error', details: errorPayload },
        { status: resp.status }
      );
    }

    const data = isJson ? await resp.json() : await resp.text();
    return NextResponse.json(typeof data === 'string' ? { data } : data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Internal error', message }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';


