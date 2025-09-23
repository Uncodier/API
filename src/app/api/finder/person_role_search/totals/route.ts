import { NextRequest, NextResponse } from 'next/server';
import { logInfo } from '@/lib/utils/api-response-utils';

export async function POST(req: NextRequest) {
  let requestBody: unknown;
  try {
    const isDev = process.env.NODE_ENV !== 'production';
    const preview = (val: unknown): string => {
      try {
        const str = typeof val === 'string' ? val : JSON.stringify(val);
        return str.length > 1000 ? `${str.slice(0, 1000)}…` : str;
      } catch {
        return '[unserializable]';
      }
    };
    const foragerApiKey = process.env.FORAGER_API_KEY;
    const foragerAccountId = process.env.FORAGER_ACCOUNT_ID;

    if (!foragerApiKey || !foragerAccountId) {
      return NextResponse.json(
        { error: 'Missing FORAGER_API_KEY or FORAGER_ACCOUNT_ID env vars' },
        { status: 500 }
      );
    }

    requestBody = await req.json();

    // Normalize payload (ensure page starts at 1 if provided)
    const normalizePage = (val: unknown): unknown => {
      if (val === 0 || val === '0') return 1;
      if (typeof val === 'number') return Math.max(1, Math.trunc(val));
      if (typeof val === 'string' && /^\d+$/.test(val)) {
        const n = parseInt(val, 10);
        return Math.max(1, n);
      }
      return val;
    };

    let payload: unknown = requestBody;
    if (requestBody && typeof requestBody === 'object') {
      const obj = { ...(requestBody as Record<string, unknown>) };
      if ('page' in obj) {
        obj.page = normalizePage((obj as any).page);
      }
      payload = obj;
    }

    const url = `https://api-v2.forager.ai/api/${encodeURIComponent(
      foragerAccountId
    )}/datastorage/person_role_search/totals/`;

    logInfo('finder.person_role_search.totals', 'Upstream request', { url, body: payload });

    const upstreamResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': foragerApiKey
      },
      body: JSON.stringify(payload)
    });

    const contentType = upstreamResponse.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');

    if (!upstreamResponse.ok) {
      const rawError = isJson
        ? await upstreamResponse.json().catch(() => ({ error: 'Upstream error (invalid JSON)' }))
        : await upstreamResponse.text().catch(() => 'Upstream error');

      if (isDev) {
        console.error('[finder.person_role_search.totals] Upstream error', {
          url,
          params: payload,
          upstream: {
            status: upstreamResponse.status,
            ok: upstreamResponse.ok,
            contentType
          },
          responsePreview: preview(rawError)
        });
      }

      const debug = {
        params: payload,
        upstream: {
          status: upstreamResponse.status,
          ok: upstreamResponse.ok,
          contentType
        },
        response: typeof rawError === 'string' ? rawError : rawError
      };

      return NextResponse.json(
        { error: 'Forager API error', debug },
        { status: upstreamResponse.status }
      );
    }

    const data = isJson ? await upstreamResponse.json() : await upstreamResponse.text();
    return NextResponse.json(typeof data === 'string' ? { data } : data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (process.env.NODE_ENV !== 'production') {
      console.error('[finder.person_role_search.totals] Handler exception', {
        message,
        params: requestBody
      });
    }
    return NextResponse.json(
      { error: 'Internal error', message, debug: { params: requestBody } },
      { status: 500 }
    );
  }
}

export const dynamic = 'force-dynamic';


