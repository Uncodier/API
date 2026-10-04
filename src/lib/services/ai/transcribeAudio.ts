import { fetchTwilioMedia, isTwilioMediaUrl } from '@/lib/services/twilio/fetchTwilioMedia';
import { recordTelemetry } from '@/lib/status/telemetry';
import { getAzureTranscriptionConfig } from './azure-transcription-config';

const LOG_PREFIX = '[TranscribeAudio]';

export type TranscriptionAttempt = { provider: 'azure-direct'; model: string };

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

/** Never route user audio through OpenRouter or fall back to another account. */
export function buildTranscriptionPlan(env: NodeJS.Dict<string> = process.env): TranscriptionAttempt[] {
  try {
    const config = getAzureTranscriptionConfig(env);
    return [{ provider: 'azure-direct', model: config.deployment }];
  } catch {
    return [];
  }
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

function audioFileExtension(mimeType: string): string {
  const formats: Record<string, string> = {
    'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
    'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
    'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/aac': 'aac',
  };
  const format = formats[mimeType];
  if (!format) throw new Error('Unsupported Azure transcription audio format');
  return format;
}

async function runAttempt(
  attempt: TranscriptionAttempt,
  buffer: Buffer,
  mimeType: string,
  env: NodeJS.Dict<string>
): Promise<{ text: string; usage?: Record<string, unknown>; generationId?: string }> {
  const config = getAzureTranscriptionConfig(env);
  const path = config.apiVersion === 'v1' || config.apiVersion === 'preview'
    ? '/openai/v1/audio/transcriptions'
    : `/openai/deployments/${encodeURIComponent(attempt.model)}/audio/transcriptions`;
  const url = new URL(path, config.origin);
  if (config.apiVersion !== 'v1') url.searchParams.set('api-version', config.apiVersion);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), `audio.${audioFileExtension(mimeType)}`);
  form.append('model', attempt.model);
  form.append('response_format', 'json');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': config.apiKey },
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error('Azure transcription request failed');
  const data = await response.json() as { text?: string; usage?: Record<string, unknown> };
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  if (!text) throw new Error('Azure returned empty transcription');
  return { text, usage: data.usage, generationId: response.headers.get('apim-request-id') || undefined };
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
      error: 'Azure transcription is not configured or invalid. Set AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT and Azure endpoint/API key credentials.',
    };
  }

  if (input.buffer.length === 0 || input.buffer.length > 25 * 1024 * 1024) {
    return { success: false, error: 'Audio must be non-empty and no larger than 25 MiB' };
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
      // Do not log provider errors: upstream bodies can echo credentials or user audio.
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
