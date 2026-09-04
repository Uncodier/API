import { NextRequest, NextResponse } from 'next/server';
import { SummaryGenerationService } from '@/lib/services/summary/SummaryGenerationService';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, source, site_id = '00000000-0000-0000-0000-000000000000' } = body || {};

    const hasText = typeof text === 'string' && text.trim().length > 0;
    const hasSource = Boolean(source?.collection && source?.id);

    if (!hasText && !hasSource) {
      return NextResponse.json(
        { error: 'Either "text" or "source.collection" and "source.id" are required' },
        { status: 400 }
      );
    }

    const result = hasSource
      ? await SummaryGenerationService.summarizeSource({
          collection: source.collection,
          id: source.id,
          site_id,
        })
      : await SummaryGenerationService.summarize({
          text,
          site_id,
        });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status || 500 }
      );
    }

    return NextResponse.json({
      success: true,
      summary: result.summary,
    });
  } catch (error: any) {
    console.error('[ai/summary] API error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to process request' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Summary API',
    usage: {
      method: 'POST',
      body: {
        text: 'optional raw text to summarize',
        source: {
          collection: 'optional: records | catalog_items',
          id: 'entity uuid — long text stays server-side',
        },
        site_id: 'optional site uuid',
      },
    },
  });
}
