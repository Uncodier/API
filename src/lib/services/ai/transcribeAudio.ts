import { fetchTwilioMedia, isTwilioMediaUrl } from '@/lib/services/twilio/fetchTwilioMedia';
import { recordTelemetry } from '@/lib/status/telemetry';
import { createOpenRouterClient } from './openrouter';

const LOG_PREFIX = '[TranscribeAudio]';

export type TranscriptionAttempt = { provider: 'openrouter'; model: string };

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
  usage?: Record<string, unknown>;
  generationId?: string;
}

function envValue(env: NodeJS.Dict<string>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

/** Only the selected OpenRouter account can receive transcription requests. */
export function buildTranscriptionPlan(env: NodeJS.Dict<string> = process.env): TranscriptionAttempt[] {
  const model = envValue(env, 'OPENROUTER_TRANSCRIPTION_MODEL');
  return model && model.includes('/') && envValue(env, 'OPENROUTER_API_KEY')
    ? [{ provider: 'openrouter', model }] : [];
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

function openRouterAudioFormat(mimeType: string): string {
  const formats: Record<string, string> = {
    'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
    'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
    'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/aac': 'aac',
  };
  const format = formats[mimeType];
  if (!format) throw new Error('Unsupported OpenRouter transcription audio format');
  return format;
}

async function runAttempt(
  attempt: TranscriptionAttempt,
  buffer: Buffer,
  mimeType: string,
  env: NodeJS.Dict<string>
): Promise<{ text: string; usage?: Record<string, unknown>; generationId?: string }> {
  const client = createOpenRouterClient({ env, timeout: 120_000 });
  // OpenRouter STT uses JSON/base64, not the OpenAI multipart upload API.
  const { data, response } = await client.post<unknown, {
    text?: string; usage?: Record<string, unknown>; id?: string;
  }>('/audio/transcriptions', {
    body: { model: attempt.model, input_audio: {
      data: buffer.toString('base64'), format: openRouterAudioFormat(mimeType),
    } },
  }).withResponse();
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  if (!text) throw new Error('OpenRouter returned empty transcription');
  return { text, usage: data.usage, generationId: response.headers.get('x-generation-id') || data.id };
}

export async function transcribeAudioBuffer(
  input: TranscribeAudioInput,
  env: NodeJS.Dict<string> = process.env
): Promise<TranscribeAudioResult> {
  const mimeType = normalizeAudioMimeType(input.contentType);
  const plan = buildTranscriptionPlan(env);

  if (plan.length === 0) {
    return {
      success: false,
      error: 'Audio transcription is not configured. Set OPENROUTER_API_KEY and a qualified OPENROUTER_TRANSCRIPTION_MODEL.',
    };
  }

  const start = Date.now();
  for (const attempt of plan) {
    try {
      console.log(`${LOG_PREFIX} Attempting transcription via ${attempt.provider} (${attempt.model})...`);
      const result = await runAttempt(attempt, input.buffer, mimeType, env);
      console.log(`${LOG_PREFIX} ${attempt.provider} transcription successful.`);
      recordTelemetry('ai_audio', 'up', `Transcription successful via ${attempt.provider}`, Date.now() - start).catch(console.error);
      return {
        success: true,
        ...result,
        provider: attempt.provider,
        model: attempt.model,
      };
    } catch {
      // Do not log SDK errors: upstream bodies can echo credentials or user audio.
      console.warn(`${LOG_PREFIX} ${attempt.provider} transcription failed.`);
    }
  }

  recordTelemetry('ai_audio', 'down', 'Configured transcription provider failed', Date.now() - start).catch(console.error);
  return {
    success: false,
    provider: plan[0].provider,
    model: plan[0].model,
    error: 'Configured audio transcription provider failed',
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
