import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const ALLOWED_CATEGORIES = [
  'industries',
  'organizations',
  'organization_keywords',
  'locations',
  'person_skills',
  'web_technologies',
] as const;

const GetFinderCategoryIdsSchema = z.object({
  category: z.enum(ALLOWED_CATEGORIES),
  q: z.string().min(1, 'q (search term) is required'),
  page: z.number().int().min(1).optional().default(1),
});

/**
 * Core logic: fetches category IDs from Finder autocomplete (Forager)
 * Use this BEFORE analyzeICPTotalCount or createIcpMining - those tools need IDs, not free text
 */
export async function getFinderCategoryIdsCore(params: {
  category: (typeof ALLOWED_CATEGORIES)[number];
  q: string;
  page?: number;
}) {
  const validated = GetFinderCategoryIdsSchema.parse(params);

  const qs = new URLSearchParams([
    ['page', String(validated.page)],
    ['q', validated.q],
  ]).toString();

  const url = `https://api-v2.forager.ai/api/datastorage/autocomplete/${encodeURIComponent(validated.category)}/?${qs}`;

  const response = await fetch(url, { method: 'GET' });
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    return {
      success: false,
      error: 'Finder autocomplete temporarily unavailable',
      data: typeof data === 'object' ? data : { raw: data },
    };
  }

  return {
    success: true,
    category: validated.category,
    data: typeof data === 'object' ? data : { data },
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getFinderCategoryIdsCore(body);
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
