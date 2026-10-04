import { getAzureTtsConfig, AZURE_TTS_MAX_CHARS, TTSServiceError } from './azure-tts-config';
import { readResponseWithLimit } from '@/lib/security/limited-response';

export { TTSServiceError } from './azure-tts-config';
export type TTSProvider = 'azure';
export type TTSAudioFormat = 'mp3' | 'pcm' | 'wav' | 'opus' | 'aac' | 'flac';

export interface SpeechOptions {
  text: string; provider?: TTSProvider; voice?: string; format?: TTSAudioFormat; model?: string; speed?: number;
}

/** Stale gateway/provider environment selectors cannot redirect speech traffic. */
export function resolveTTSProvider(provider?: string): TTSProvider {
  if (provider !== undefined && provider !== 'azure') {
    throw new TTSServiceError('Only direct Azure TTS is supported; omit provider or use azure', 400);
  }
  return 'azure';
}

const MIME_TYPES: Record<TTSAudioFormat, string> = {
  mp3: 'audio/mpeg', pcm: 'audio/pcm', wav: 'audio/wav', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac',
};

export function ttsMimeType(format: TTSAudioFormat): string {
  return MIME_TYPES[format];
}

/** Shared validation lets tool callers reject bad input before charging credits. */
export function validateSpeechOptions(options: SpeechOptions) {
  const provider = resolveTTSProvider(options.provider);
  const format = options.format ?? 'mp3';
  if (typeof options.text !== 'string' || !options.text.trim() || options.text.length > AZURE_TTS_MAX_CHARS) {
    throw new TTSServiceError(`Speech input must contain 1 to ${AZURE_TTS_MAX_CHARS} characters`, 400);
  }
  if (!Object.hasOwn(MIME_TYPES, format)) {
    throw new TTSServiceError('Azure speech supports mp3, pcm, wav, opus, aac or flac', 400);
  }
  const { voice, model, speed } = options;
  if (voice !== undefined && (typeof voice !== 'string' || !voice.trim())) {
    throw new TTSServiceError('Speech voice must be a non-empty Azure OpenAI voice', 400);
  }
  if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model))) {
    throw new TTSServiceError('model must be an Azure speech deployment name, not a qualified gateway model ID', 400);
  }
  if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.25 || speed > 4)) {
    throw new TTSServiceError('Speech speed must be between 0.25 and 4', 400);
  }
  const config = getAzureTtsConfig();
  // Deployment aliases cannot identify the underlying model; Azure validates voice support.
  return { provider, format, config, deployment: model ?? config.deployment, voice: voice?.trim() ?? config.voice };
}

/** Direct Azure OpenAI data plane, with bounded output and no retries or account fallback. */
export async function synthesizeWithAzure(
  text: string, voice?: string, format: TTSAudioFormat = 'mp3', model?: string, speed?: number,
): Promise<Buffer> {
  if (typeof window !== 'undefined') throw new TTSServiceError('Azure speech credentials are server-only', 503);
  const selected = validateSpeechOptions({ text, voice, format, model, speed });
  const url = new URL(`/openai/deployments/${encodeURIComponent(selected.deployment)}/audio/speech`, selected.config.origin);
  url.searchParams.set('api-version', selected.config.apiVersion);
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'api-key': selected.config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, model: selected.deployment, voice: selected.voice, response_format: format,
        ...(speed !== undefined ? { speed } : {}) }),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new TTSServiceError(`Azure TTS request failed (${response.status})`);
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
      throw new TTSServiceError('Azure TTS returned a non-audio response');
    }
    const audio = await readResponseWithLimit(response, 32 * 1024 * 1024);
    if (!audio.length) throw new TTSServiceError('Azure TTS returned empty audio');
    return audio;
  } catch (error) {
    if (error instanceof TTSServiceError) throw error;
    // Upstream errors may echo input or keys. Never expose them or retry a billable request.
    throw new TTSServiceError('Azure TTS request failed or timed out; generation outcome may be uncertain');
  }
}

export async function synthesizeSpeech(options: SpeechOptions): Promise<{
  audio: Buffer; provider: TTSProvider; format: TTSAudioFormat; mimeType: string;
}> {
  const provider = resolveTTSProvider(options.provider);
  const format = options.format ?? 'mp3';
  const audio = await synthesizeWithAzure(options.text, options.voice, format, options.model, options.speed);
  return { audio, provider, format, mimeType: ttsMimeType(format) };
}
