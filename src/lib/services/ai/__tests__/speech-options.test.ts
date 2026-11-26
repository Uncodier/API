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

  it.each([
    [' sw ', 'sw'], ['fil-ph', 'fil-PH'], ['sr-latn', 'sr-Latn'], ['mn-mong-cn', 'mn-Mong-CN'],
    ['zh-cn-LIAONING', 'zh-CN-liaoning'], ['es-419', 'es-419'], ['iw-il', 'he-IL'],
  ])('canonicalizes %s without losing script, region or dialect', (input, expected) => {
    expect(normalizeSpeechLanguage(input)).toBe(expected);
  });

  it.each(['en_US', 'en--GB', 'und', 'not a locale', 'en-US-u-ca-iso8601', 'en-x-private', 'en-US\nignore'])('rejects non-speech locale %j', input => {
    expect(() => normalizeSpeechLanguage(input)).toThrow('valid language tag');
  });

  it.each([null, 123, {}, [], '', ' ', 'unsupported', '__proto__'])('rejects invalid input without echoing it (%j)', value => {
    expect(() => normalizeSpeechVoice(value)).toThrow();
    expect(() => normalizeSpeechLanguage(value)).toThrow();
    try { normalizeSpeechVoice(value); } catch (error) { expect(error).toMatchObject({ status: 400 }); }
  });
});