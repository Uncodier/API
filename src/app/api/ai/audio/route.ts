import { NextRequest, NextResponse } from 'next/server';

type Provider = 'vercel' | 'azure' | 'gemini';

interface AudioRequestBody {
  text: string;
  voice?: string;
  format?: 'mp3' | 'wav' | 'ogg';
  provider?: Provider;
  model?: string;
}

function getEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[audio api] Missing environment variable ${name}`);
  }
  return value;
}

async function synthesizeWithVercel(text: string, voice?: string, format?: string, model?: string) {
  const baseURL = getEnv('VERCEL_AI_GATEWAY_OPENAI');
  const apiKey = getEnv('VERCEL_AI_GATEWAY_API_KEY');
  if (!baseURL || !apiKey) {
    throw new Error('Vercel AI Gateway is not configured');
  }

  const resp = await fetch(`${baseURL.replace(/\/$/, '')}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini-tts',
      input: text,
      voice: voice || 'alloy',
      format: format || 'mp3',
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Vercel Gateway TTS failed: ${resp.status} ${text}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as AudioRequestBody;
    const { text, voice, format, provider = 'vercel', model } = body || {};

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Parameter "text" is required' }, { status: 400 });
    }

    if (provider === 'vercel') {
      const audio = await synthesizeWithVercel(text, voice, format, model);
      return new NextResponse(audio, {
        status: 200,
        headers: {
          'Content-Type': format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg',
          'Content-Length': String(audio.length),
        },
      });
    }

    if (provider === 'azure' || provider === 'gemini') {
      return NextResponse.json(
        { error: 'TTS via Azure/Gemini is not implemented here. Use provider: "vercel".' },
        { status: 501 }
      );
    }

    return NextResponse.json({ error: `Unsupported provider: ${provider}` }, { status: 400 });
  } catch (error: any) {
    console.error('[audio api] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to process request' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Audio (Text-to-Speech) API',
    usage: {
      method: 'POST',
      body: {
        text: 'string',
        voice: 'string (optional)',
        format: "'mp3' | 'wav' | 'ogg' (optional, default: 'mp3')",
        provider: "'vercel' | 'azure' | 'gemini' (default: 'vercel')",
        model: 'optional model id (provider specific)'
      },
    },
    providers: ['vercel'],
    env: {
      requiredForVercel: ['VERCEL_AI_GATEWAY_OPENAI', 'VERCEL_AI_GATEWAY_API_KEY'],
    },
  });
}


