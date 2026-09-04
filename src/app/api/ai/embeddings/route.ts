import { NextRequest, NextResponse } from 'next/server';
import Portkey from 'portkey-ai';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    console.warn(`[embeddings api] Missing environment variable ${name}`);
  }
  return value;
}

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

    const apiKey = getEnv('PORTKEY_API_KEY');
    const virtualKey = getEnv('AZURE_OPENAI_API_KEY');

    if (!apiKey || !virtualKey) {
      return NextResponse.json(
        { error: 'Portkey embeddings are not configured' },
        { status: 500 }
      );
    }

    const portkey = new Portkey({
      apiKey,
      virtualKey,
      baseURL: 'https://api.portkey.ai/v1',
    });

    console.log(`[embeddings api] Creating embeddings with model ${modelId} via Portkey`);

    const response = await portkey.embeddings.create({
      input,
      model: modelId,
      dimensions,
    });

    const embeddings = (response.data || [])
      .map((item) => item?.embedding)
      .filter((vector): vector is number[] => Array.isArray(vector));

    if (embeddings.length === 0) {
      console.error('[embeddings api] Portkey returned no valid vectors:', response);
      return NextResponse.json(
        { error: 'Portkey did not return a valid embedding' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      model: modelId,
      embedding: embeddings[0],
      embeddings,
      usage: response.usage,
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
