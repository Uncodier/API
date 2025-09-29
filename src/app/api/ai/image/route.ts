import { NextRequest, NextResponse } from 'next/server';

type Provider = 'azure' | 'gemini' | 'vercel';

interface ImageRequestBody {
  prompt: string;
  provider?: Provider;
  size?: '256x256' | '512x512' | '1024x1024';
  n?: number;
  quality?: 'standard' | 'hd';
}

function getEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[image api] Missing environment variable ${name}`);
  }
  return value;
}

async function generateWithAzure(prompt: string, size?: string, n?: number, quality?: 'standard' | 'hd') {
  const endpoint = getEnv('AZURE_OPENAI_ENDPOINT');
  const apiKey = getEnv('AZURE_OPENAI_API_KEY');
  const deployment = getEnv('AZURE_OPENAI_IMAGES_DEPLOYMENT'); // e.g. "dall-e-3"
  const apiVersion = getEnv('AZURE_OPENAI_API_VERSION') || '2024-09-01-preview';

  if (!endpoint || !apiKey || !deployment) {
    throw new Error('Azure OpenAI image generation is not configured');
  }

  const url = `${endpoint.replace(/\/$/, '')}/openai/images/generations?api-version=${encodeURIComponent(apiVersion)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      model: deployment,
      prompt,
      size: size || '1024x1024',
      n: n || 1,
      quality,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Azure image generation failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const images = (data?.data || []).map((d: any) => ({ url: d.url, b64_json: d.b64_json }));
  return { provider: 'azure', images };
}

async function generateWithVercelGateway(prompt: string, size?: string, n?: number) {
  const baseURL = getEnv('VERCEL_AI_GATEWAY_OPENAI');
  const apiKey = getEnv('VERCEL_AI_GATEWAY_API_KEY');

  if (!baseURL || !apiKey) {
    throw new Error('Vercel AI Gateway is not configured');
  }

  const resp = await fetch(`${baseURL.replace(/\/$/, '')}/v1/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: size || '1024x1024',
      n: n || 1,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Vercel Gateway image generation failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const images = (data?.data || []).map((d: any) => ({ url: d.url, b64_json: d.b64_json }));
  return { provider: 'vercel', images };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ImageRequestBody;
    const { prompt, provider = 'azure', size, n, quality } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Parameter "prompt" is required' }, { status: 400 });
    }

    if (provider === 'azure') {
      try {
        const result = await generateWithAzure(prompt, size, n, quality);
        return NextResponse.json(result);
      } catch (err) {
        console.warn('[image api] Azure provider failed, trying Vercel fallback...', err);
        const fallback = await generateWithVercelGateway(prompt, size, n);
        return NextResponse.json({ ...fallback, fallbackFrom: 'azure' });
      }
    }

    if (provider === 'gemini') {
      return NextResponse.json(
        {
          error: 'Gemini image generation is not implemented via official SDK in this project. Use Azure or Vercel gateway.',
        },
        { status: 501 }
      );
    }

    if (provider === 'vercel') {
      const result = await generateWithVercelGateway(prompt, size, n);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: `Unsupported provider: ${provider}` }, { status: 400 });
  } catch (error: any) {
    console.error('[image api] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to process request' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Image Generation API',
    usage: {
      method: 'POST',
      body: {
        prompt: 'string',
        provider: "'azure' | 'gemini' | 'vercel' (default: 'azure')",
        size: "'256x256' | '512x512' | '1024x1024'",
        n: 'number',
        quality: "'standard' | 'hd'",
      },
    },
    providers: ['azure', 'gemini', 'vercel'],
    env: {
      requiredForAzure: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_IMAGES_DEPLOYMENT'],
      requiredForVercelFallback: ['VERCEL_AI_GATEWAY_OPENAI', 'VERCEL_AI_GATEWAY_API_KEY'],
    },
  });
}


