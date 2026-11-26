import { TTSServiceError } from './azure-tts-config';

export const TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
// Examples for API discovery, not a catalog of available synthesis locales.
export const TTS_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar',
  'hi', 'ru', 'nl', 'pl', 'tr', 'sv', 'id', 'uk', 'vi',
] as const;
export type TTSVoice = typeof TTS_VOICES[number];
export type TTSLanguage = string;

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

/** Validate the locale shape here; regional availability is checked against the service catalog. */
export function normalizeSpeechLanguage(value: unknown): TTSLanguage | undefined {
  if (value === undefined) return undefined;
  const tag = typeof value === 'string' ? value.trim() : '';
  if (tag.toLowerCase() === 'auto') return undefined;
  // Speech locales take a language and optional script, region and variants,
  // not private-use or formatting extensions (such as calendar preferences).
  if (tag.length <= 80 && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag)) {
    try {
      const [locale] = Intl.getCanonicalLocales(tag);
      if (locale.split('-')[0] !== 'und') return locale;
    } catch { /* malformed subtags */ }
  }
  throw new TTSServiceError('Speech language must be auto or a valid language tag', 400);
}