import { GoogleGenAI } from '@google/genai';

export type TTSProvider = 'vercel' | 'azure' | 'gemini';

function getEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[tts-service] Missing environment variable ${name}`);
  }
  return value;
}

export async function synthesizeWithVercel(text: string, voice?: string, format?: string, model?: string) {
  const rawBase = getEnv('VERCEL_AI_GATEWAY_OPENAI') || getEnv('VERCEL_AI_GATEWAY');
  const apiKey = getEnv('VERCEL_AI_GATEWAY_API_KEY');
  if (!rawBase || !apiKey) {
    throw new Error('Vercel AI Gateway is not configured');
  }

  const baseURL = rawBase.replace(/\/$/, '').replace(/\/v1$/, '');
  const resp = await fetch(`${baseURL}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'tts-1',
      input: text,
      voice: voice || 'alloy',
      format: format || 'mp3',
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => '');
    throw new Error(`Vercel Gateway TTS failed: ${resp.status} ${errorText}`);
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

export async function synthesizeWithGemini(text: string, voice?: string, format?: string, model?: string) {
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
