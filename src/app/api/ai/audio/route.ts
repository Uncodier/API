import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

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

function writeWavHeader(buffer: Buffer, sampleRate = 24000, numChannels = 1, bitDepth = 16): Buffer {
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const wavHeader = Buffer.alloc(44);

  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(buffer.length + 36, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(numChannels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitDepth, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(buffer.length, 40);

  return Buffer.concat([wavHeader, buffer]);
}

async function synthesizeWithGemini(text: string, voice?: string, format?: string, model?: string) {
  const apiKey = getEnv('GEMINI_API_KEY') || getEnv('GOOGLE_CLOUD_API_KEY');
  if (!apiKey) {
    throw new Error('Gemini API key is not configured');
  }

  const ai = new GoogleGenAI({ apiKey });
  const selectedModel = model || 'gemini-3.1-flash-tts-preview';
  
  // Gemini TTS voice options: Aoede, Charon, Fenrir, Kore, Puck (default: Puck)
  const selectedVoice = voice || 'Puck';

  const response = await ai.models.generateContent({
    model: selectedModel,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: selectedVoice
          }
        }
      }
    },
    contents: text
  });

  const audioPart = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!audioPart || !audioPart.inlineData || typeof audioPart.inlineData.data !== 'string') {
    throw new Error('Gemini API did not return audio data');
  }

  const rawBuffer = Buffer.from(audioPart.inlineData.data, 'base64');

  // Currently Gemini returns raw PCM audio (audio/l16; rate=24000; channels=1)
  // We wrap it in a standard WAV header so it's playable everywhere.
  return writeWavHeader(rawBuffer, 24000, 1, 16);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as AudioRequestBody;
    const { text, voice, format, provider = 'gemini', model } = body || {};

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
        console.warn(`[audio api] Gemini provider failed, trying Vercel fallback...`, geminiError);
        try {
          const audio = await synthesizeWithVercel(text, voice, format, model);
          return new NextResponse(audio as any, {
            status: 200,
            headers: {
              'Content-Type': format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg',
              'Content-Length': String(audio.length),
              'X-Fallback-Provider': 'vercel'
            },
          });
        } catch (fallbackError: any) {
          throw new Error(`Both Gemini and Vercel failed. Gemini: ${geminiError.message}. Vercel: ${fallbackError.message}`);
        }
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
      gemini: 'Uses models/gemini-3.1-flash-tts-preview model to generate native audio. Always returns WAV format.',
      voices: 'Gemini supports Aoede, Charon, Fenrir, Kore, Puck (default).'
    }
  });
}


