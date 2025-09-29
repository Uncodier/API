import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { prompt, provider } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Parameter "prompt" is required' }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: 'Video generation is not implemented with official SDKs in this project yet. No reliable SDK endpoints are available. Consider external providers specialized in text-to-video, or integrate via a separate service.',
        providerRequested: provider || null,
      },
      { status: 501 }
    );
  } catch (error: any) {
    console.error('[video api] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to process request' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Video Generation API',
    status: 'not_implemented',
    reason: 'No official, stable Node SDK for text-to-video is integrated here.',
  });
}



