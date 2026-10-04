import { NextRequest, NextResponse } from 'next/server';
import { synthesizeSpeech, TTSServiceError, TTSProvider as Provider, TTSAudioFormat } from '@/lib/services/ai/tts-service';
import { getOpenRouterTtsModel, getOpenRouterTtsVoice } from '@/lib/services/ai/openrouter';
import {
  enforceRequestRateLimit,
  getAuthenticatedRateIdentity,
  isInternalServiceRequest,
} from '@/lib/security/request-rate-limit';

interface AudioRequestBody {
  text: string;
  voice?: string;
  format?: TTSAudioFormat;
  provider?: Provider;
  model?: string;
  speed?: number;
}

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const limited = await enforceRequestRateLimit(request, {
      namespace: 'ai-audio-principal',
      identity: getAuthenticatedRateIdentity(request),
      limit: isInternalServiceRequest(request) ? 120 : 20,
      windowSeconds: 60,
      failClosed: true,
    });
    if (limited) return limited;

    const body = (await request.json()) as AudioRequestBody;
    const { text, voice, format, provider, model, speed } = body || {};

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Parameter "text" is required' }, { status: 400 });
    }
    if (text.length > 20_000) {
      return NextResponse.json({ error: 'Parameter "text" is too long' }, { status: 413 });
    }

    for (const value of [voice, format, provider, model]) {
      if (value !== undefined && typeof value !== 'string') {
        return NextResponse.json({ error: 'Audio options must be strings' }, { status: 400 });
      }
    }
    const result = await synthesizeSpeech({ text, voice, format, provider, model, speed });
    return new NextResponse(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        'Content-Type': result.mimeType,
        'Content-Length': String(result.audio.length),
        'X-TTS-Provider': result.provider,
      },
    });
  } catch (error) {
    const status = error instanceof TTSServiceError ? error.status : error instanceof SyntaxError ? 400 : 502;
    // Raw SDK errors can echo keys or input. Expose only our safe adapter errors.
    return NextResponse.json(
      { error: error instanceof TTSServiceError ? error.message : 'Failed to process audio request' },
      { status }
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
        voice: 'optional; must be supported by the selected OpenRouter speech model',
        format: "'mp3' | 'pcm' (default: 'mp3')",
        provider: "'openrouter' (only supported gateway)",
        model: 'optional qualified OpenRouter speech model ID',
        speed: 'optional number from 0.25 to 4, where supported'
      },
    },
    providers: ['openrouter'],
    defaults: { model: getOpenRouterTtsModel(), voice: getOpenRouterTtsVoice(getOpenRouterTtsModel()) },
    env: {
      required: ['OPENROUTER_API_KEY'],
      optional: ['OPENROUTER_TTS_MODEL', 'OPENROUTER_TTS_VOICE'],
    },
    notes: {
      routing: 'Uses the same OpenRouter key and fixed gateway as chat. No Azure endpoint or provider keys required.',
      voices: 'When selecting a different model, also select a compatible voice.'
    }
  });
}


