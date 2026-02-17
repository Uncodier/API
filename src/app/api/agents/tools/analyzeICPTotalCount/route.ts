import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Schema for ICP total count (person_role_search totals)
 * Accepts same structure as finder: flat payload or nested under query
 * Finder uses: person_industries, person_locations, person_skills, organization_domains,
 * organization_industries, organization_locations, organization_keywords, organization_web_technologies,
 * role_title, role_description, etc.
 */
const AnalyzeICPTotalCountSchema = z.object({
  site_id: z.string().uuid().optional(),
  query: z.record(z.unknown()).optional(),
}).passthrough();

type FinderQuery = Record<string, unknown>;

const FORAGER_NON_PAYLOAD_KEYS = new Set(['site_id', 'query']);

function normalizePage(value: unknown): unknown {
  if (value === 0 || value === '0') return 1;
  if (typeof value === 'number') return Math.max(1, Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = parseInt(value, 10);
    return Math.max(1, n);
  }
  return value;
}

/**
 * Build Forager payload from args. Finder sends flat body - merge query + top-level filters.
 * Same format as /api/finder/person_role_search/totals
 */
function buildPayload(params: Record<string, unknown>): FinderQuery {
  const validated = AnalyzeICPTotalCountSchema.parse(params);
  const queryObj = validated.query && typeof validated.query === 'object'
    ? (validated.query as Record<string, unknown>)
    : {};
  const flatFilters = Object.fromEntries(
    Object.entries(validated).filter(
      ([k]) => !FORAGER_NON_PAYLOAD_KEYS.has(k)
    )
  );
  const payload = { ...queryObj, ...flatFilters };
  if ('page' in payload) {
    payload.page = normalizePage(payload.page);
  }
  return payload;
}

/**
 * Core logic: fetches ICP total count (Forager person_role_search totals)
 * Uses same Forager API as finder app - accepts flat finder payload
 */
export async function analyzeICPTotalCountCore(params: Record<string, unknown>) {
  const foragerApiKey = process.env.FORAGER_API_KEY;
  const foragerAccountId = process.env.FORAGER_ACCOUNT_ID;

  if (!foragerApiKey || !foragerAccountId) {
    return {
      success: false,
      error: 'Finder/Forager API not configured (FORAGER_API_KEY, FORAGER_ACCOUNT_ID)',
      data: null,
    };
  }

  const payload = buildPayload(params);

  const url = `https://api-v2.forager.ai/api/${encodeURIComponent(
    foragerAccountId
  )}/datastorage/person_role_search/totals/`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': foragerApiKey,
    },
    body: JSON.stringify(payload),
  });

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    return {
      success: false,
      error: 'Finder search service temporarily unavailable',
      data: typeof data === 'object' ? data : { raw: data },
    };
  }

  const siteId = params && typeof params === 'object' && 'site_id' in params
    ? (params as { site_id?: string }).site_id
    : undefined;

  return {
    success: true,
    data: typeof data === 'object' ? data : { total: data },
    site_id: siteId,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await analyzeICPTotalCountCore(body);
    return NextResponse.json(result, {
      status: result.success ? 200 : 500,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid parameters',
          details: error.errors,
        },
        { status: 400 }
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
