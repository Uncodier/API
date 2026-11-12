import { NextRequest, NextResponse } from 'next/server';
import { SummaryGenerationService } from '@/lib/services/summary/SummaryGenerationService';
import {
  enforceRequestRateLimit,
  getAuthenticatedRateIdentity,
} from '@/lib/security/request-rate-limit';
import { authorizeInferenceRequest, withHttpExecutionRouting } from '@/lib/services/ai/customer-routing-http';
import { withCustomerCapability } from '@/lib/services/ai/customer-routing';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { principal, routing } = await authorizeInferenceRequest(request, body?.site_id);
    const limited = await enforceRequestRateLimit(request, {
      namespace: 'ai-summary-principal',
      identity: getAuthenticatedRateIdentity(request),
      limit: principal.internal ? 300 : 30,
      windowSeconds: 60,
      failClosed: true,
    });
    if (limited) return limited;

    const { text, source, site_id } = body || {};

    const hasText = typeof text === 'string' && text.trim().length > 0;
    const hasSource = Boolean(source?.collection && source?.id);

    if (!hasText && !hasSource) {
      return NextResponse.json(
        { error: 'Either "text" or "source.collection" and "source.id" are required' },
        { status: 400 }
      );
    }
    if (
      typeof site_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(site_id)
    ) {
      return NextResponse.json(
        { error: 'A valid site_id is required' },
        { status: 400 },
      );
    }
    if (hasText && text.length > 100_000) {
      return NextResponse.json(
        { error: 'Text exceeds 100000 characters' },
        { status: 413 },
      );
    }
    const summarize = () => withCustomerCapability('summary', () => hasSource
      ? SummaryGenerationService.summarizeSource({
          collection: source.collection,
          id: source.id,
          site_id,
        })
      : SummaryGenerationService.summarize({
          text,
          site_id,
        }));
    const result = routing ? await withHttpExecutionRouting(request, routing, summarize) : await summarize();

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
    console.error('[ai/summary] API error');
    return NextResponse.json(
      { error: 'Failed to process summary request' },
      { status: error instanceof SyntaxError ? 400 : [400, 401, 403, 402, 422].includes(error?.status) ? error.status : 500 }
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
