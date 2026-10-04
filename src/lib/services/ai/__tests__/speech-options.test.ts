import { normalizeSpeechVoice, normalizeSpeechLanguage, TTS_VOICES, TTS_LANGUAGES } from '../speech-options';

describe('speech selections', () => {
  it.each([undefined, 'auto', ' AUTO '])('normalizes %s as no forced selection', value => {
    expect(normalizeSpeechVoice(value)).toBeUndefined();
    expect(normalizeSpeechLanguage(value)).toBeUndefined();
  });

  it.each(TTS_VOICES)('preserves listed voice %s', value => {
    expect(normalizeSpeechVoice(value)).toBe(value);
    expect(normalizeSpeechVoice(` ${value.toUpperCase()} `)).toBe(value);
  });

  it.each(TTS_LANGUAGES)('preserves listed spoken language %s', value => {
    expect(normalizeSpeechLanguage(value)).toBe(value);
    expect(normalizeSpeechLanguage(` ${value.toUpperCase()} `)).toBe(value);
  });

  it.each([null, 123, {}, [], '', ' ', 'unsupported', '__proto__'])('rejects invalid input without echoing it (%j)', value => {
    expect(() => normalizeSpeechVoice(value)).toThrow();
    expect(() => normalizeSpeechLanguage(value)).toThrow();
    try { normalizeSpeechVoice(value); } catch (error) { expect(error).toMatchObject({ status: 400 }); }
  });
});