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

export async function GET(req: NextRequest, context: { params: { category?: string } }) {
  try {
    const foragerApiKey = process.env.FORAGER_API_KEY;
    const foragerAccountId = process.env.FORAGER_ACCOUNT_ID;

    if (!foragerApiKey || !foragerAccountId) {
      return NextResponse.json(
        { error: 'Missing FORAGER_API_KEY or FORAGER_ACCOUNT_ID env vars' },
        { status: 500 }
      );
    }

    const category = (context.params?.category || '').toLowerCase();
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
    const page = searchParams.get('page') || '0';

    const upstreamUrl = `https://api-v2.forager.ai/api/datastorage/autocomplete/${encodeURIComponent(
      category
    )}/?${new URLSearchParams({ q, page }).toString()}`;

    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        'X-API-KEY': foragerApiKey
      }
    });

    const contentType = upstreamResponse.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');

    if (!upstreamResponse.ok) {
      const errorPayload = isJson
        ? await upstreamResponse.json().catch(() => ({ message: 'Upstream error (invalid JSON)' }))
        : { message: await upstreamResponse.text().catch(() => 'Upstream error') };
      return NextResponse.json(
        { error: 'Forager API error', details: errorPayload },
        { status: upstreamResponse.status }
      );
    }

    const data = isJson ? await upstreamResponse.json() : await upstreamResponse.text();
    return NextResponse.json(typeof data === 'string' ? { data } : data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Internal error', message }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';


