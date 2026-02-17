import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createIcpMiningCore } from '@/lib/services/finder/create-icp-mining';

/**
 * Same format as finder: flat payload or nested under query.
 * Finder uses: person_industries, person_locations, person_skills, organization_domains, etc.
 */
const CreateIcpMiningSchema = z.object({
  site_id: z.string().uuid('site_id must be valid UUID'),
  query: z.record(z.unknown()).optional(),
  segment_id: z.string().uuid().optional(),
  name: z.string().min(1, 'name must be non-empty').optional(),
  total_targets: z.number().int().min(0).optional(),
}).passthrough();

const FORAGER_NON_PAYLOAD_KEYS = new Set(['site_id', 'query', 'segment_id', 'name', 'total_targets']);

function normalizePage(value: unknown): unknown {
  if (typeof value === 'number') return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = parseInt(value, 10);
    return Math.max(0, n);
  }
  return value;
}

/**
 * Build Forager query from args. Same format as finder - merge query + flat filters.
 */
function buildQuery(params: Record<string, unknown>): Record<string, unknown> {
  const validated = CreateIcpMiningSchema.parse(params);
  const queryObj = validated.query && typeof validated.query === 'object'
    ? (validated.query as Record<string, unknown>)
    : {};
  const flatFilters = Object.fromEntries(
    Object.entries(validated).filter(([k]) => !FORAGER_NON_PAYLOAD_KEYS.has(k))
  );
  const payload = { ...queryObj, ...flatFilters };
  if (Object.keys(payload).length === 0) {
    throw new Error('At least one filter is required (person_industries, organization_domains, role_title, etc.)');
  }
  if ('page' in payload) {
    payload.page = normalizePage(payload.page);
  }
  return payload;
}

export async function createIcpMiningCoreFromRoute(params: Record<string, unknown>) {
  const validated = CreateIcpMiningSchema.parse(params);
  const siteId = validated.site_id as string;
  if (!siteId) {
    return { success: false, error: 'site_id is required' };
  }
  let query: Record<string, unknown>;
  try {
    query = buildQuery(params);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'At least one filter is required',
    };
  }
  return createIcpMiningCore({
    site_id: siteId,
    query,
    segment_id: validated.segment_id as string | undefined,
    name: validated.name as string | undefined,
    total_targets: validated.total_targets as number | undefined,
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createIcpMiningCoreFromRoute(body);
    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result, { status: 200 });
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
