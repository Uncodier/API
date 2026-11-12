import { NextRequest, NextResponse } from 'next/server';
import { EmbeddingsService } from '@/lib/services/embeddings-service';
import { authorizeInferenceRequest, withHttpExecutionRouting } from '@/lib/services/ai/customer-routing-http';
import {
  enforceRequestRateLimit,
  getAuthenticatedRateIdentity,
} from '@/lib/security/request-rate-limit';

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
    const { principal, routing } = await authorizeInferenceRequest(request, body?.site_id);
    const limited = await enforceRequestRateLimit(request, {
      namespace: 'ai-embeddings-principal',
      identity: getAuthenticatedRateIdentity(request),
      limit: principal.internal ? 300 : 60,
      windowSeconds: 60,
      failClosed: true,
    });
    if (limited) return limited;

    const { input, modelId = DEFAULT_MODEL, dimensions = DEFAULT_DIMENSIONS } = body || {};

    if (!isValidInput(input)) {
      return NextResponse.json(
        { error: 'Parameter "input" is required (non-empty string or string[])' },
        { status: 400 }
      );
    }
    const values = Array.isArray(input) ? input : [input];
    const totalCharacters = values.reduce(
      (total, value) => total + value.length,
      0,
    );
    if (values.length > 100 || totalCharacters > 100_000) {
      return NextResponse.json(
        { error: 'Embedding input exceeds request limits' },
        { status: 413 },
      );
    }
    if (
      !Number.isSafeInteger(dimensions)
      || dimensions < 1
      || dimensions > 3_072
    ) {
      return NextResponse.json(
        { error: 'Parameter "dimensions" must be an integer between 1 and 3072' },
        { status: 400 },
      );
    }

    if (typeof modelId !== 'string' || !modelId.trim()) {
      return NextResponse.json({ error: 'Parameter "modelId" must be a non-empty string' }, { status: 400 });
    }
    const generate = () => EmbeddingsService.generateEmbeddings(input, modelId, dimensions);
    const { embeddings, usage, model } = routing
      ? await withHttpExecutionRouting(request, routing, generate) : await generate();

    return NextResponse.json({
      success: true,
      model,
      provider: 'openrouter',
      embedding: embeddings[0],
      embeddings,
      usage,
    });
  } catch (error: any) {
    console.error('[embeddings api] OpenRouter embeddings request failed');
    return NextResponse.json(
      {
        error: 'Failed to generate embedding',
      },
      { status: error instanceof SyntaxError ? 400 : [400, 401, 403, 402, 422].includes(error?.status) ? error.status : 500 }
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
      required: ['OPENROUTER_API_KEY'],
    },
  });
}
