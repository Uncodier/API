import { NextRequest, NextResponse } from 'next/server';
import { logInfo, logError } from '@/lib/utils/api-response-utils';
import { normalizePersonRoleSearchPayload } from '@/lib/finder/normalize-person-role-search-payload';

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

    // Log incoming request to debug what properties are received
    logInfo('finder.person_role_search', 'Incoming request body', { 
      body: requestBody,
      hasOrganizationDomains: requestBody && typeof requestBody === 'object' && 'organization_domains' in requestBody
    });

    const normalizePage = (val: unknown): unknown => {
      if (typeof val === 'number') return Math.max(0, Math.trunc(val));
      if (typeof val === 'string' && /^\d+$/.test(val)) {
        const n = parseInt(val, 10);
        return Math.max(0, n);
      }
      return val;
    };

    let payload: unknown = requestBody;
    if (requestBody && typeof requestBody === 'object') {
      const obj = { ...(requestBody as Record<string, unknown>) };
      normalizePersonRoleSearchPayload(obj, { normalizePage });
      payload = obj;
    }

    const url = `https://api-v2.forager.ai/api/${encodeURIComponent(
      foragerAccountId
    )}/datastorage/person_role_search/`;

    // Log payload with explicit check for organization_domains
    const payloadObj = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
    const orgDomains = payloadObj && 'organization_domains' in payloadObj ? payloadObj.organization_domains : undefined;
    
    logInfo('finder.person_role_search', 'Upstream request', { 
      url, 
      body: payload,
      organization_domains: orgDomains,
      organization_domains_type: Array.isArray(orgDomains) ? 'array' : typeof orgDomains
    });

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

      logError('finder.person_role_search', 'Upstream error', {
        url,
        params: payload,
        upstream: {
          status: upstreamResponse.status,
          ok: upstreamResponse.ok,
          contentType
        },
        responsePreview: preview(rawError)
      });

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
        { error: 'Search service temporarily unavailable', debug },
        { status: upstreamResponse.status }
      );
    }

    const data = isJson ? await upstreamResponse.json() : await upstreamResponse.text();
    return NextResponse.json(typeof data === 'string' ? { data } : data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('finder.person_role_search', 'Handler exception', error instanceof Error ? { message: error.message, stack: error.stack, params: requestBody } : { error, params: requestBody });
    return NextResponse.json(
      { error: 'Internal error', message, debug: { params: requestBody } },
      { status: 500 }
    );
  }
}

export const dynamic = 'force-dynamic';

