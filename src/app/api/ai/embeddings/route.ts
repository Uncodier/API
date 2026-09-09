import { NextRequest, NextResponse } from 'next/server';
import { EmbeddingsService } from '@/lib/services/embeddings-service';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

function isValidInput(input: unknown): input is string | string[] {
  if (typeof input === 'string') {
    return input.trim().length > 0;
  }
  return Array.isArray(input) && input.length > 0 && input.every(
    (item) => typeof item === 'string' && item.trim().length > 0
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { input, modelId = DEFAULT_MODEL, dimensions = DEFAULT_DIMENSIONS } = body || {};

    if (!isValidInput(input)) {
      return NextResponse.json(
        { error: 'Parameter "input" is required (non-empty string or string[])' },
        { status: 400 }
      );
    }

    const { embeddings, usage } = await EmbeddingsService.generateEmbeddings(input, modelId, dimensions);

    return NextResponse.json({
      success: true,
      model: modelId,
      embedding: embeddings[0],
      embeddings,
      usage,
    });
  } catch (error: any) {
    console.error('[embeddings api] Error:', error);
    return NextResponse.json(
      {
        error: error?.message || 'Failed to generate embedding',
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Embeddings API',
    usage: {
      method: 'POST',
      body: {
        input: 'string or string[]',
        modelId: `optional, default ${DEFAULT_MODEL}`,
        dimensions: `optional, default ${DEFAULT_DIMENSIONS}`,
      },
    },
    env: {
      required: ['PORTKEY_API_KEY', 'AZURE_OPENAI_API_KEY'],
    },
  });
}
