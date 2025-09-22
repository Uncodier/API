import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const foragerApiKey = process.env.FORAGER_API_KEY;
    const foragerAccountId = process.env.FORAGER_ACCOUNT_ID;

    if (!foragerApiKey || !foragerAccountId) {
      return NextResponse.json(
        { error: 'Missing FORAGER_API_KEY or FORAGER_ACCOUNT_ID env vars' },
        { status: 500 }
      );
    }

    const requestBody = await req.json();

    const url = `https://api-v2.forager.ai/api/${encodeURIComponent(
      foragerAccountId
    )}/datastorage/person_role_search/`;

    const upstreamResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': foragerApiKey
      },
      body: JSON.stringify(requestBody)
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

