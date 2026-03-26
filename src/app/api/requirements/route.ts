import { NextRequest, NextResponse } from 'next/server';
import { getRequirements } from '@/lib/database/requirement-db';
import { z } from 'zod';

const GetRequirementsSchema = z.object({
  site_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  status: z.string().optional(),
  completion_status: z.string().optional(),
  created_at_from: z.string().optional(),
  created_at_to: z.string().optional(),
  updated_at_from: z.string().optional(),
  updated_at_to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const filters = {
      site_id: searchParams.get('site_id') || undefined,
      user_id: searchParams.get('user_id') || undefined,
      status: searchParams.get('status') || undefined,
      completion_status: searchParams.get('completion_status') || undefined,
      created_at_from: searchParams.get('created_at_from') || undefined,
      created_at_to: searchParams.get('created_at_to') || undefined,
      updated_at_from: searchParams.get('updated_at_from') || undefined,
      updated_at_to: searchParams.get('updated_at_to') || undefined,
      limit: searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : undefined,
      offset: searchParams.get('offset') ? parseInt(searchParams.get('offset')!) : undefined,
    };

    const validatedFilters = GetRequirementsSchema.parse(filters);

    // Fetch requirements that are NOT completed AND NOT validated
    // Interpret "no completados o validados" as excluding both completed and validated status
    const { requirements, total, hasMore } = await getRequirements({
      ...validatedFilters,
      excluded_statuses: ['validated'],
      excluded_completion_statuses: ['completed'],
    });

    return NextResponse.json({
      success: true,
      data: {
        requirements,
        pagination: {
          total,
          count: requirements.length,
          has_more: hasMore,
          limit: validatedFilters.limit,
          offset: validatedFilters.offset,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching requirements:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
