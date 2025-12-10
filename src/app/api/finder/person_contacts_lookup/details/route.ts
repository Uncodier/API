import { NextRequest, NextResponse } from 'next/server';
import { logInfo, logError } from '@/lib/utils/api-response-utils';

export async function POST(req: NextRequest) {
  let requestBody: unknown;
  try {
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

    // Validate request body
    if (!requestBody || typeof requestBody !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const body = requestBody as Record<string, unknown>;
    const hasPersonId = 'person_id' in body && body.person_id !== undefined && body.person_id !== null;
    const hasLinkedInId = 'linkedin_public_identifier' in body && 
      typeof body.linkedin_public_identifier === 'string' && 
      body.linkedin_public_identifier.trim() !== '';

    if (!hasPersonId && !hasLinkedInId) {
      return NextResponse.json(
        { error: 'At least one of person_id or linkedin_public_identifier must be provided' },
        { status: 400 }
      );
    }

    // Build payload
    const payload: Record<string, unknown> = {};
    if (hasPersonId) {
      payload.person_id = body.person_id;
    }
    if (hasLinkedInId) {
      payload.linkedin_public_identifier = body.linkedin_public_identifier;
    }

    const url = `https://api-v2.forager.ai/api/${encodeURIComponent(
      foragerAccountId
    )}/datastorage/person_detail_lookup/`;

    logInfo('finder.person_contacts_lookup.details', 'Upstream request', { url, body: payload });

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

      logError('finder.person_contacts_lookup.details', 'Upstream error', {
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
        { error: 'Person detail lookup service temporarily unavailable', debug },
        { status: upstreamResponse.status }
      );
    }

    const data = isJson ? await upstreamResponse.json() : await upstreamResponse.text();
    return NextResponse.json(typeof data === 'string' ? { data } : data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('finder.person_contacts_lookup.details', 'Handler exception', error instanceof Error ? { message: error.message, stack: error.stack, params: requestBody } : { error, params: requestBody });
    return NextResponse.json(
      { error: 'Internal error', message, debug: { params: requestBody } },
      { status: 500 }
    );
  }
}

export const dynamic = 'force-dynamic';
















