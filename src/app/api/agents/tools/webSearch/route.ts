import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { searchWeb } from '@/lib/services/search/web-search';

export const maxDuration = 120;

const WebSearchSchema = z.object({
  query: z.string().trim().min(1, 'query is required').max(8000),
  search_depth: z.enum(['basic', 'advanced', 'comprehensive']).optional().default('basic'),
  max_results: z.number().int().min(1).max(20).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  include_answer: z.boolean().optional().default(true),
  include_images: z.boolean().optional().default(false),
  include_domains: z.array(z.string()).optional(),
  exclude_domains: z.array(z.string()).optional(),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const params = WebSearchSchema.parse(body);

    const result = await searchWeb(params.query, {
      search_depth: params.search_depth,
      max_results: params.max_results ?? (params.limit === undefined ? 5 : undefined),
      limit: params.limit,
      include_answer: params.include_answer,
      include_images: params.include_images,
      include_domains: params.include_domains,
      exclude_domains: params.exclude_domains,
    });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.error_status }
      );
    }

    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'Invalid parameters', details: error.errors },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
