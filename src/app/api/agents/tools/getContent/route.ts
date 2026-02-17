import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getContents, getContentById } from '@/lib/database/content-db';

const GetContentSchema = z.object({
  content_id: z.string().uuid().optional(),
  site_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  campaign_id: z.string().uuid().optional(),
  segment_id: z.string().uuid().optional(),
  search: z.string().optional(),
  sort_by: z
    .enum(['created_at', 'updated_at', 'title', 'status', 'published_at'])
    .optional()
    .default('created_at'),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
  limit: z.number().int().min(1).max(500).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Core logic for getContent - callable from route or assistant protocol
 */
export async function getContentCore(filters: Record<string, unknown>) {
  const validated = GetContentSchema.parse(filters);

  if (validated.content_id) {
    const content = await getContentById(validated.content_id);
    return {
      success: true,
      data: {
        content: content ?? null,
        pagination: null,
      },
    };
  }

  const filterObj = {
    site_id: validated.site_id,
    user_id: validated.user_id,
    type: validated.type,
    status: validated.status,
    campaign_id: validated.campaign_id,
    segment_id: validated.segment_id,
    search: validated.search,
    sort_by: validated.sort_by,
    sort_order: validated.sort_order,
    limit: validated.limit,
    offset: validated.offset,
  };

  const { contents, total, hasMore } = await getContents(filterObj);

  return {
    success: true,
    data: {
      contents,
      pagination: {
        total,
        count: contents.length,
        offset: validated.offset,
        limit: validated.limit,
        has_more: hasMore,
      },
    },
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getContentCore(body);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid filters',
          details: error.errors,
        },
        { status: 400 }
      );
    }
    if (error instanceof Error) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 500 }
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
}
