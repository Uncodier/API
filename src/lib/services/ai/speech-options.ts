import { TTSServiceError } from './azure-tts-config';

export const TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
export const TTS_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar',
  'hi', 'ru', 'nl', 'pl', 'tr', 'sv', 'id', 'uk', 'vi',
] as const;
export type TTSVoice = typeof TTS_VOICES[number];
export type TTSLanguage = typeof TTS_LANGUAGES[number];

function normalizeSelection<T extends string>(
  value: unknown, options: readonly T[], field: 'voice' | 'language',
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new TTSServiceError(`Speech ${field} must be auto or a supported ${field}`, 400);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto') return undefined;
  if (!options.includes(normalized as T)) {
    throw new TTSServiceError(`Unsupported speech ${field}; choose auto or a listed ${field}`, 400);
  }
  return normalized as T;
}

export function normalizeSpeechVoice(value: unknown): TTSVoice | undefined {
  return normalizeSelection(value, TTS_VOICES, 'voice');
}

/** Language guides the agent's text, not an unsupported Azure synthesis parameter. */
export function normalizeSpeechLanguage(value: unknown): TTSLanguage | undefined {
  return normalizeSelection(value, TTS_LANGUAGES, 'language');
}