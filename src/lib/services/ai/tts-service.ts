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

  const gatewayOrigin = new URL(rawBase).origin;
  const selectedModel = model?.includes('/') ? model : `openai/${model || 'tts-1'}`;
  const outputFormat = format || 'mp3';
  const resp = await fetch(`${gatewayOrigin}/v4/ai/speech-model`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'ai-gateway-protocol-version': '0.0.1',
      'ai-speech-model-specification-version': '4',
      'ai-model-id': selectedModel,
    },
    body: JSON.stringify({
      text,
      voice: voice || 'alloy',
      outputFormat,
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => '');
    throw new Error(`Vercel Gateway TTS failed: ${resp.status} ${errorText}`);
  }

  const result = await resp.json();
  if (!result?.audio || typeof result.audio !== 'string') {
    throw new Error('Vercel Gateway TTS did not return base64 audio data');
  }

  return Buffer.from(result.audio, 'base64');
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

export async function encodePcm16LeToMp3(
  pcmBuffer: Buffer,
  sampleRate = 24000,
  kbps = 64
): Promise<Buffer> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const samples = new Int16Array(Math.floor(pcmBuffer.length / 2));
  for (let index = 0; index < samples.length; index++) {
    samples[index] = pcmBuffer.readInt16LE(index * 2);
  }

  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const mp3Chunks: Buffer[] = [];
  const sampleBlockSize = 1152;

  for (let offset = 0; offset < samples.length; offset += sampleBlockSize) {
    const encoded = encoder.encodeBuffer(samples.subarray(offset, offset + sampleBlockSize));
    if (encoded.length > 0) {
      mp3Chunks.push(Buffer.from(encoded));
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) {
    mp3Chunks.push(Buffer.from(flushed));
  }

  return Buffer.concat(mp3Chunks);
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

  // Gemini returns raw PCM audio (audio/l16; rate=24000; channels=1).
  // WhatsApp does not accept WAV, so encode MP3 when explicitly requested.
  if (format === 'mp3') {
    return await encodePcm16LeToMp3(rawBuffer, 24000);
  }

  return writeWavHeader(rawBuffer, 24000, 1, 16);
}
