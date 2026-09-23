import {
  mergeVoiceAgentPreferences,
  readVoiceAgentPreferences,
  toVoiceConnectionMetadata,
  validateVoiceAgentPreferences,
} from "../voice-preferences";

const catalog = {
  items: [
    { id: "voice-en", name: "Thalia", language: "en" },
    { id: "voice-es", name: "Celeste", language: "es" },
  ],
  languages: ["auto", "en", "es"],
};

describe("Voice agent preferences", () => {
  it("defaults to automatic language detection", () => {
    expect(readVoiceAgentPreferences({})).toEqual({ language: "auto" });
  });

  it("merges explicit changes and supports clearing a selected voice", () => {
    expect(mergeVoiceAgentPreferences(
      { language: "en", ttsVoiceId: "voice-en" },
      { language: "es", ttsVoiceId: null }
    )).toEqual({ language: "es" });
  });

  it("validates the voice against the selected language", () => {
    expect(() => validateVoiceAgentPreferences(
      { language: "es", ttsVoiceId: "voice-es" },
      catalog
    )).not.toThrow();
    expect(() => validateVoiceAgentPreferences(
      { language: "es", ttsVoiceId: "voice-en" },
      catalog
    )).toThrow("does not support this language");
  });

  it("serializes preferences for channel metadata", () => {
    expect(toVoiceConnectionMetadata({
      language: "auto",
    })).toEqual({
      voice_language: "auto",
      tts_voice_id: null,
    });
  });
});
