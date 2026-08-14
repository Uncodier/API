import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { fetchTwilioMedia, isTwilioMediaUrl } from '@/lib/services/twilio/fetchTwilioMedia';

export const WHISPER_MODEL = 'whisper-1';

export const DEFAULT_GEMINI_AUDIO_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
] as const;

const LOG_PREFIX = '[TranscribeAudio]';

export type TranscriptionAttempt =
  | { provider: 'gemini'; model: string }
  | { provider: 'openai-direct'; model: typeof WHISPER_MODEL }
  | { provider: 'vercel-gateway'; model: typeof WHISPER_MODEL }
  | { provider: 'portkey-openai'; model: typeof WHISPER_MODEL; virtualKey: string };

export interface TranscribeAudioInput {
  buffer: Buffer;
  contentType?: string;
}

export interface TranscribeAudioResult {
  success: boolean;
  text?: string;
  provider?: string;
  model?: string;
  error?: string;
}

function envValue(env: NodeJS.Dict<string>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

/**
 * Gemini 1.5 Pro was retired and returns 404 on generateContent.
 * Prefer GEMINI_AUDIO_MODEL, then current multimodal Flash models.
 */
export function resolveGeminiAudioModels(env: NodeJS.Dict<string> = process.env): string[] {
  const configured = envValue(env, 'GEMINI_AUDIO_MODEL');
  const models = [...DEFAULT_GEMINI_AUDIO_MODELS];
  if (!configured) return models;
  return [configured, ...models.filter((model) => model !== configured)];
}

/**
 * Azure chat virtual keys are bound to deployments like gpt-5-mini.
 * audioTranscriptions only works with Whisper (native OpenAI or a dedicated
 * OpenAI virtual key) — never with the Azure chat virtual key.
 */
export function resolveWhisperPortkeyVirtualKey(
  env: NodeJS.Dict<string> = process.env
): string | undefined {
  return envValue(env, 'PORTKEY_VIRTUAL_KEY_OPENAI');
}

export function buildTranscriptionPlan(
  env: NodeJS.Dict<string> = process.env
): TranscriptionAttempt[] {
  const plan: TranscriptionAttempt[] = [];

  if (envValue(env, 'GEMINI_API_KEY')) {
    for (const model of resolveGeminiAudioModels(env)) {
      plan.push({ provider: 'gemini', model });
    }
  }

  if (envValue(env, 'OPENAI_API_KEY')) {
    plan.push({ provider: 'openai-direct', model: WHISPER_MODEL });
  }

  if (envValue(env, 'VERCEL_AI_GATEWAY_OPENAI') && envValue(env, 'VERCEL_AI_GATEWAY_API_KEY')) {
    plan.push({ provider: 'vercel-gateway', model: WHISPER_MODEL });
  }

  const portkeyVirtualKey = resolveWhisperPortkeyVirtualKey(env);
  if (envValue(env, 'PORTKEY_API_KEY') && portkeyVirtualKey) {
    plan.push({
      provider: 'portkey-openai',
      model: WHISPER_MODEL,
      virtualKey: portkeyVirtualKey,
    });
  }

  return plan;
}

export function normalizeAudioMimeType(contentType?: string): string {
  const raw = (contentType || 'audio/mpeg').split(';')[0].trim().toLowerCase();
  if (raw === 'audio/mpeg' || raw === 'audio/mpga') return 'audio/mp3';
  if (raw === 'audio/x-wav' || raw === 'audio/wave') return 'audio/wav';
  if (raw === 'audio/x-m4a') return 'audio/m4a';
  if (raw === 'application/ogg') return 'audio/ogg';
  if (raw === 'application/octet-stream') return 'audio/ogg';
  return raw || 'audio/mpeg';
}

export function whisperFileExtension(contentType?: string): string {
  const mime = normalizeAudioMimeType(contentType);
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('m4a')) return 'm4a';
  return 'mp3';
}

async function transcribeWithGemini(
  apiKey: string,
  model: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model });
  const result = await genModel.generateContent([
    'Please transcribe this audio exactly as spoken, without adding any commentary or extra text.',
    {
      inlineData: {
        mimeType,
        data: buffer.toString('base64'),
      },
    },
  ]);
  const text = result.response.text()?.trim();
  if (!text) throw new Error('Gemini returned empty transcription');
  return text;
}

async function transcribeWithWhisper(
  client: { audio: { transcriptions: { create: (opts: any) => Promise<{ text?: string }> } } },
  buffer: Buffer,
  mimeType: string,
  fileExt: string
): Promise<string> {
  const file = await OpenAI.toFile(buffer, `audio.${fileExt}`, { type: mimeType });
  const transcription = await client.audio.transcriptions.create({
    file,
    model: WHISPER_MODEL,
  });
  const text = transcription?.text?.trim();
  if (!text) throw new Error('Whisper returned empty transcription');
  return text;
}

async function runAttempt(
  attempt: TranscriptionAttempt,
  buffer: Buffer,
  mimeType: string,
  fileExt: string,
  env: NodeJS.Dict<string>
): Promise<string> {
  if (attempt.provider === 'gemini') {
    return transcribeWithGemini(envValue(env, 'GEMINI_API_KEY')!, attempt.model, buffer, mimeType);
  }

  if (attempt.provider === 'openai-direct') {
    const client = new OpenAI({
      apiKey: envValue(env, 'OPENAI_API_KEY'),
      baseURL: 'https://api.openai.com/v1',
    });
    return transcribeWithWhisper(client, buffer, mimeType, fileExt);
  }

  if (attempt.provider === 'vercel-gateway') {
    const baseURL = envValue(env, 'VERCEL_AI_GATEWAY_OPENAI')!.replace(/\/$/, '');
    const client = new OpenAI({
      apiKey: envValue(env, 'VERCEL_AI_GATEWAY_API_KEY'),
      baseURL: `${baseURL}/v1`,
    });
    return transcribeWithWhisper(client, buffer, mimeType, fileExt);
  }

  const portkeyModule: any = await import('portkey-ai');
  const Portkey = portkeyModule.Portkey || portkeyModule.default;
  const portkey = new Portkey({
    apiKey: envValue(env, 'PORTKEY_API_KEY'),
    baseURL: 'https://api.portkey.ai/v1',
    provider: 'openai',
    virtualKey: attempt.virtualKey,
  });
  return transcribeWithWhisper(portkey, buffer, mimeType, fileExt);
}

export async function transcribeAudioBuffer(
  input: TranscribeAudioInput,
  env: NodeJS.Dict<string> = process.env
): Promise<TranscribeAudioResult> {
  const mimeType = normalizeAudioMimeType(input.contentType);
  const fileExt = whisperFileExtension(mimeType);
  const plan = buildTranscriptionPlan(env);

  if (plan.length === 0) {
    return {
      success: false,
      error: 'No audio transcription provider is configured',
    };
  }

  if (envValue(env, 'PORTKEY_API_KEY') && envValue(env, 'AZURE_OPENAI_API_KEY') && !resolveWhisperPortkeyVirtualKey(env)) {
    console.warn(
      `${LOG_PREFIX} Skipping Portkey Azure virtual key — chat deployments cannot run audioTranscriptions. Set PORTKEY_VIRTUAL_KEY_OPENAI for Whisper via Portkey.`
    );
  }

  let lastError: Error | undefined;
  for (const attempt of plan) {
    try {
      console.log(`${LOG_PREFIX} Attempting transcription via ${attempt.provider} (${attempt.model})...`);
      const text = await runAttempt(attempt, input.buffer, mimeType, fileExt, env);
      console.log(`${LOG_PREFIX} ${attempt.provider} transcription successful.`);
      return {
        success: true,
        text,
        provider: attempt.provider,
        model: attempt.model,
      };
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err?.message || err));
      console.warn(`${LOG_PREFIX} ${attempt.provider} (${attempt.model}) failed: ${lastError.message}`);
    }
  }

  return {
    success: false,
    error: `All audio transcription providers failed. Last error: ${lastError?.message || 'unknown error'}`,
  };
}

export interface FetchAudioOptions {
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  env?: NodeJS.Dict<string>;
}

export async function fetchAudioBuffer(
  audioUrl: string,
  options: FetchAudioOptions = {}
): Promise<{ buffer: Buffer; contentType: string }> {
  const env = options.env || process.env;

  if (isTwilioMediaUrl(audioUrl)) {
    const downloaded = await fetchTwilioMedia(
      audioUrl,
      {
        accountSid: options.twilioAccountSid,
        authToken: options.twilioAuthToken,
      },
      env
    );
    return {
      buffer: Buffer.from(downloaded.buffer),
      contentType: downloaded.contentType || 'audio/mpeg',
    };
  }

  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') || 'audio/mpeg',
  };
}
