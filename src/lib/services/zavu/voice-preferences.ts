export const AUTO_VOICE_LANGUAGE = "auto";

export interface ZavuAgentVoice {
  id: string;
  name: string;
  language: string;
}

export interface ZavuAgentVoiceCatalog {
  items: ZavuAgentVoice[];
  languages: string[];
  total?: number;
}

export interface VoiceAgentPreferences {
  language: string;
  ttsVoiceId?: string;
}

export interface VoiceAgentPreferencesPatch {
  language?: string;
  ttsVoiceId?: string | null;
}

const BCP_47_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function invalidPreference(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readVoiceAgentPreferences(
  configuration: unknown
): VoiceAgentPreferences {
  const voice = (configuration as any)?.zavu?.voice;
  const storedLanguage = optionalTrimmedString(voice?.language);
  const language =
    storedLanguage === AUTO_VOICE_LANGUAGE ||
    (storedLanguage && BCP_47_PATTERN.test(storedLanguage))
      ? storedLanguage
      : AUTO_VOICE_LANGUAGE;
  return {
    language,
    ...(optionalTrimmedString(voice?.ttsVoiceId)
      ? { ttsVoiceId: voice.ttsVoiceId.trim() }
      : {}),
  };
}

export function mergeVoiceAgentPreferences(
  current: VoiceAgentPreferences,
  patch: VoiceAgentPreferencesPatch
): VoiceAgentPreferences {
  const language =
    patch.language === undefined
      ? current.language
      : patch.language.trim() || AUTO_VOICE_LANGUAGE;
  const ttsVoiceId =
    patch.ttsVoiceId === undefined
      ? current.ttsVoiceId
      : optionalTrimmedString(patch.ttsVoiceId);

  return {
    language,
    ...(ttsVoiceId ? { ttsVoiceId } : {}),
  };
}

export function validateVoiceAgentPreferences(
  preferences: VoiceAgentPreferences,
  catalog: ZavuAgentVoiceCatalog
): void {
  const { language, ttsVoiceId } = preferences;
  if (
    language !== AUTO_VOICE_LANGUAGE &&
    (!BCP_47_PATTERN.test(language) || !catalog.languages.includes(language))
  ) {
    throw invalidPreference(`Unsupported Voice language: ${language}`);
  }

  if (!ttsVoiceId) return;
  const voice = catalog.items.find((item) => item.id === ttsVoiceId);
  if (!voice) {
    throw invalidPreference("The selected Voice is no longer available");
  }
  if (
    language !== AUTO_VOICE_LANGUAGE &&
    voice.language !== language
  ) {
    throw invalidPreference("The selected Voice does not support this language");
  }
}

export function toVoiceConnectionMetadata(
  preferences: VoiceAgentPreferences
): Record<string, string | null> {
  return {
    voice_language: preferences.language,
    tts_voice_id: preferences.ttsVoiceId || null,
  };
}
