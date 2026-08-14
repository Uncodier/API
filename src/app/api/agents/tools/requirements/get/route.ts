import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequirements } from '@/lib/database/requirement-db';
import { shouldUseRemoteApi, invokeRemoteTool, RemoteToolError } from '@/lib/mcp/remote-client';
import {
  DATE_PERIODS,
  coerceDateOnlyBound,
  computeAppliedRange,
  exclusiveEndToInclusiveIso,
  isLocalDateString,
  resolveClientTimezone,
} from '@/lib/timezone';

const GetRequirementsSchema = z.object({
  site_id: z.string().uuid('Site ID is required'),
  user_id: z.string().uuid().optional(),
  campaign_id: z.string().uuid().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  completion_status: z.string().optional(),
  priority: z.string().optional(),
  search: z.string().optional(),
  created_at_from: z.string().optional(),
  created_at_to: z.string().optional(),
  updated_at_from: z.string().optional(),
  updated_at_to: z.string().optional(),
  period: z.enum(DATE_PERIODS).optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be YYYY-MM-DD').optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be YYYY-MM-DD').optional(),
  date_column: z.enum(['created_at', 'updated_at']).optional(),
  excluded_statuses: z.array(z.string()).optional(),
  excluded_completion_statuses: z.array(z.string()).optional(),
  sort_by: z.enum(['created_at', 'updated_at', 'title', 'priority', 'status']).optional().default('created_at'),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
  limit: z.number().int().min(1).max(500).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
});

export type GetRequirementsFilters = z.infer<typeof GetRequirementsSchema>;

/**
 * Core logic for getRequirements - callable from route or assistant protocol
 */
export async function getRequirementsCore(filters: Record<string, unknown>) {
  // Support Remote Mode (MCP without DB access)
  if (shouldUseRemoteApi()) {
    console.log('[Requirements] Using Remote API mode');
    // Note: The path here should match the API route path relative to API_URL
    return invokeRemoteTool('/api/agents/tools/requirements/get', filters);
  }

  const validatedFilters = GetRequirementsSchema.parse(filters);

  const needsTimezone = Boolean(
    validatedFilters.period ||
    validatedFilters.date_from ||
    validatedFilters.date_to ||
    [validatedFilters.created_at_from, validatedFilters.created_at_to, validatedFilters.updated_at_from, validatedFilters.updated_at_to]
      .some(value => isLocalDateString(value))
  );

  const timezone = needsTimezone
    ? await resolveClientTimezone({
        userId: validatedFilters.user_id,
        siteId: validatedFilters.site_id,
      })
    : undefined;

  const applied_range = timezone
    ? computeAppliedRange(timezone, {
        period: validatedFilters.period,
        date_from: validatedFilters.date_from,
        date_to: validatedFilters.date_to,
      })
    : null;

  let created_at_from = validatedFilters.created_at_from;
  let created_at_to = validatedFilters.created_at_to;
  let updated_at_from = validatedFilters.updated_at_from;
  let updated_at_to = validatedFilters.updated_at_to;

  if (applied_range) {
    const inclusiveTo = exclusiveEndToInclusiveIso(applied_range.end_utc);
    const dateColumn = validatedFilters.date_column ?? 'created_at';
    if (dateColumn === 'updated_at') {
      updated_at_from = applied_range.start_utc;
      updated_at_to = inclusiveTo;
    } else {
      created_at_from = applied_range.start_utc;
      created_at_to = inclusiveTo;
    }
  } else if (timezone) {
    created_at_from = coerceDateOnlyBound(created_at_from, timezone, 'start');
    created_at_to = coerceDateOnlyBound(created_at_to, timezone, 'endInclusive');
    updated_at_from = coerceDateOnlyBound(updated_at_from, timezone, 'start');
    updated_at_to = coerceDateOnlyBound(updated_at_to, timezone, 'endInclusive');
  }

  const { requirements, total, hasMore } = await getRequirements({
    ...validatedFilters,
    created_at_from,
    created_at_to,
    updated_at_from,
    updated_at_to,
  });

  return {
    success: true,
    data: {
      requirements,
      pagination: {
        total,
        count: requirements.length,
        offset: validatedFilters.offset,
        limit: validatedFilters.limit,
        has_more: hasMore,
      },
    },
    applied_range: applied_range ?? undefined,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getRequirementsCore(body);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid filters',
        details: error.errors,
      }, { status: 400 });
    }

    if (error instanceof RemoteToolError) {
      return NextResponse.json(error.data || {
        success: false,
        error: error.message
      }, { status: error.status });
    }

    if (error instanceof Error) {
      return NextResponse.json({
        success: false,
        error: error.message,
      }, { status: 500 });
    }
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
    }, { status: 500 });
  }
}
