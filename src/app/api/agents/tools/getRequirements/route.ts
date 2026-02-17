import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequirements } from '@/lib/database/requirement-db';

const GetRequirementsSchema = z.object({
  site_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  campaign_id: z.string().uuid().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  completion_status: z.string().optional(),
  priority: z.string().optional(),
  search: z.string().optional(),
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
  const validatedFilters = GetRequirementsSchema.parse(filters);
  const { requirements, total, hasMore } = await getRequirements(validatedFilters);

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
