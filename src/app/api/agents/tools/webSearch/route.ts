import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { searchWithTavily } from '@/lib/services/search/data-analyst-search';

const WebSearchSchema = z.object({
  query: z.string().min(1, 'query is required'),
  search_depth: z.enum(['basic', 'advanced']).optional().default('basic'),
  max_results: z.number().int().min(1).max(20).optional().default(5),
  include_answer: z.boolean().optional().default(true),
  include_images: z.boolean().optional().default(false),
  include_domains: z.array(z.string()).optional(),
  exclude_domains: z.array(z.string()).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const params = WebSearchSchema.parse(body);

    const result = await searchWithTavily(params.query, {
      search_depth: params.search_depth,
      max_results: params.max_results,
      include_answer: params.include_answer,
      include_images: params.include_images,
      include_domains: params.include_domains,
      exclude_domains: params.exclude_domains,
    });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
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
