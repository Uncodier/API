import { createOpenRouterClient, getOpenRouterTtsModel, getOpenRouterTtsVoice } from './openrouter';

export type TTSProvider = 'openrouter';
// OpenRouter documents mp3 and pcm; do not relabel unsupported containers.
export type TTSAudioFormat = 'mp3' | 'pcm';

export class TTSServiceError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'TTSServiceError';
  }
}

/** Old environment provider selectors are deliberately ignored. */
export function resolveTTSProvider(provider?: string): TTSProvider {
  if (provider !== undefined && provider !== 'openrouter') {
    throw new TTSServiceError('Only OpenRouter TTS is supported; remove the legacy provider override', 400);
  }
  return 'openrouter';
}

export function ttsMimeType(format: TTSAudioFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/pcm';
}

export async function synthesizeWithOpenRouter(
  text: string, voice?: string, format: string = 'mp3', model?: string, speed?: number,
): Promise<Buffer> {
  const selectedModel = model ?? getOpenRouterTtsModel();
  if (typeof selectedModel !== 'string' || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/.test(selectedModel)) {
    throw new TTSServiceError('TTS requires a qualified OpenRouter speech model ID, not an Azure deployment name', 400);
  }
  const selectedVoice = voice ?? getOpenRouterTtsVoice(selectedModel);
  if (typeof selectedVoice !== 'string' || !selectedVoice.trim()) {
    throw new TTSServiceError('Set OPENROUTER_TTS_VOICE or supply a voice supported by the selected speech model', 400);
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) {
    throw new TTSServiceError('Speech input must contain 1 to 20000 characters', 400);
  }
  if (format !== 'mp3' && format !== 'pcm') {
    throw new TTSServiceError('OpenRouter speech supports mp3 or pcm; other containers are not supported', 400);
  }
  if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.25 || speed > 4)) {
    throw new TTSServiceError('Speech speed must be between 0.25 and 4', 400);
  }
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new TTSServiceError('OpenRouter TTS is not configured: set OPENROUTER_API_KEY', 503);
  }
  try {
    const response = await createOpenRouterClient({ timeout: 120_000 }).audio.speech.create({
      model: selectedModel, input: text, voice: selectedVoice, response_format: format,
      ...(speed !== undefined ? { speed } : {}),
    });
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) throw new TTSServiceError('OpenRouter TTS returned empty audio');
    return audio;
  } catch (error) {
    if (error instanceof TTSServiceError) throw error;
    // SDK responses may echo credentials/input. No retry or cross-account fallback.
    throw new TTSServiceError('OpenRouter TTS request failed');
  }
}

export async function synthesizeSpeech(options: {
  text: string; provider?: TTSProvider; voice?: string; format?: TTSAudioFormat; model?: string; speed?: number;
}): Promise<{ audio: Buffer; provider: TTSProvider; format: TTSAudioFormat; mimeType: string }> {
  const provider = resolveTTSProvider(options.provider);
  const format = options.format ?? 'mp3';
  const audio = await synthesizeWithOpenRouter(options.text, options.voice, format, options.model, options.speed);
  return { audio, provider, format, mimeType: ttsMimeType(format) };
}
