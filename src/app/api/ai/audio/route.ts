import { NextRequest, NextResponse } from 'next/server';
import { synthesizeWithVercel, synthesizeWithGemini, TTSProvider as Provider } from '@/lib/services/ai/tts-service';

interface AudioRequestBody {
  text: string;
  voice?: string;
  format?: 'mp3' | 'wav' | 'ogg';
  provider?: Provider;
  model?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as AudioRequestBody;
    let { text, voice, format, provider, model } = body || {};

    if (model === 'gpt-4o-mini-tts') {
      model = 'tts-1';
    }

    // Force provider to vercel if an OpenAI model is passed
    if (model && (model.includes('gpt') || model.includes('tts'))) {
      provider = 'vercel';
    } else if (!provider) {
      provider = 'gemini';
    }

    // If Gemini is the provider but a non-gemini model was somehow passed, clear it so the default is used
    if (provider === 'gemini' && model && !model.includes('gemini')) {
      model = undefined;
    }

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Parameter "text" is required' }, { status: 400 });
    }

    if (provider === 'vercel') {
      const audio = await synthesizeWithVercel(text, voice, format, model);
      return new NextResponse(audio as any, {
        status: 200,
        headers: {
          'Content-Type': format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg',
          'Content-Length': String(audio.length),
        },
      });
    }
    
    if (provider === 'gemini') {
      try {
        const audio = await synthesizeWithGemini(text, voice, format, model);
        // Gemini returns wrapped WAV buffer from our function
        return new NextResponse(audio as any, {
          status: 200,
          headers: {
            'Content-Type': 'audio/wav',
            'Content-Length': String(audio.length),
          },
        });
      } catch (geminiError: any) {
        console.warn(`[audio api] Gemini provider failed.`, geminiError);
        throw new Error(`Gemini failed: ${geminiError.message}`);
      }
    }

    if (provider === 'azure') {
      return NextResponse.json(
        { error: 'TTS via Azure is not implemented here. Use provider: "gemini" or "vercel".' },
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
        format: "'mp3' | 'wav' | 'ogg' (optional, default: 'mp3' or 'wav' depending on provider)",
        provider: "'gemini' | 'vercel' | 'azure' (default: 'gemini')",
        model: 'optional model id (provider specific)'
      },
    },
    providers: ['gemini', 'vercel'],
    env: {
      requiredForGemini: ['GEMINI_API_KEY'],
      requiredForVercel: ['VERCEL_AI_GATEWAY_OPENAI', 'VERCEL_AI_GATEWAY_API_KEY'],
    },
    notes: {
      gemini: 'Uses models/gemini-3.1-flash-tts-preview to generate native audio. Always returns WAV format.',
      voices: 'Gemini supports Aoede, Charon, Fenrir, Kore, Puck (default).'
    }
  });
}


