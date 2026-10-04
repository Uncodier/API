import { NextRequest, NextResponse } from 'next/server';
import { synthesizeSpeech, TTSServiceError, TTSProvider as Provider, TTSAudioFormat } from '@/lib/services/ai/tts-service';
import { AZURE_TTS_MAX_CHARS, DEFAULT_AZURE_TTS_DEPLOYMENT, DEFAULT_AZURE_TTS_VOICE } from '@/lib/services/ai/azure-tts-config';
import { TTS_VOICES, TTS_LANGUAGES } from '@/lib/services/ai/speech-options';
import {
  enforceRequestRateLimit,
  getAuthenticatedRateIdentity,
  isInternalServiceRequest,
} from '@/lib/security/request-rate-limit';

interface AudioRequestBody {
  text: string;
  voice?: string;
  language?: string;
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

    let body: AudioRequestBody;
    try { body = await request.json() as AudioRequestBody; } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
    }
    const { text, voice, language, format, provider, model, speed } = body || {};

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Parameter "text" is required' }, { status: 400 });
    }
    if (text.length > AZURE_TTS_MAX_CHARS) {
      return NextResponse.json({ error: 'Parameter "text" is too long' }, { status: 413 });
    }

    for (const value of [voice, language, format, provider, model]) {
      if (value !== undefined && typeof value !== 'string') {
        return NextResponse.json({ error: 'Audio options must be strings' }, { status: 400 });
      }
    }
    const result = await synthesizeSpeech({ text, voice, language, format, provider, model, speed });
    return new NextResponse(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        'Content-Type': result.mimeType,
        'Content-Length': String(result.audio.length),
        'X-TTS-Provider': result.provider,
        'X-TTS-Text-Language': result.language ?? 'auto',
        'Cache-Control': 'no-store',
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
        voice: 'auto (default) or alloy, echo, fable, onyx, nova, shimmer',
        language: 'auto (default) or a listed language code; text must already be in this language',
        format: "'mp3' | 'pcm' | 'wav' | 'opus' | 'aac' | 'flac' (default: 'mp3')",
        provider: "'azure' (direct; normally omit)",
        model: 'optional Azure speech deployment name, not a gateway model ID',
        speed: 'optional number from 0.25 to 4, where supported'
      },
    },
    providers: ['azure'],
    defaults: {
      model: process.env.AZURE_TTS_DEPLOYMENT?.trim() ?? DEFAULT_AZURE_TTS_DEPLOYMENT,
      voice: process.env.AZURE_TTS_VOICE?.trim() ?? DEFAULT_AZURE_TTS_VOICE,
      language: 'auto',
    },
    options: { voices: ['auto', ...TTS_VOICES], languages: ['auto', ...TTS_LANGUAGES] },
    env: {
      required: ['AZURE_TTS_ENDPOINT', 'AZURE_TTS_API_KEY'],
      optional: ['AZURE_TTS_DEPLOYMENT', 'AZURE_TTS_API_VERSION', 'AZURE_TTS_VOICE'],
    },
    notes: {
      routing: 'Calls Azure OpenAI directly with the dedicated speech resource key. No gateway fallback or retries.',
      voices: 'Azure OpenAI voices are multilingual; do not use MAI/OpenRouter voice IDs.',
      language: 'Language is agent/text guidance only. Azure tts-hd detects it from input and does not accept a language parameter or translate text.',
      maxCharacters: AZURE_TTS_MAX_CHARS,
    }
  });
}


