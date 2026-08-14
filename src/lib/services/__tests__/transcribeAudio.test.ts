import {
  buildTranscriptionPlan,
  normalizeAudioMimeType,
  resolveGeminiAudioModels,
  resolveWhisperPortkeyVirtualKey,
  whisperFileExtension,
  WHISPER_MODEL,
} from '@/lib/services/ai/transcribeAudio';

describe('transcribeAudio helpers', () => {
  describe('resolveGeminiAudioModels', () => {
    it('uses current Flash models and never gemini-1.5-pro', () => {
      const models = resolveGeminiAudioModels({});
      expect(models).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash']);
      expect(models).not.toContain('gemini-1.5-pro');
    });

    it('puts GEMINI_AUDIO_MODEL first without dropping fallbacks', () => {
      const models = resolveGeminiAudioModels({ GEMINI_AUDIO_MODEL: 'gemini-2.5-pro' });
      expect(models[0]).toBe('gemini-2.5-pro');
      expect(models).toContain('gemini-2.5-flash');
      expect(models).toContain('gemini-2.0-flash');
    });
  });

  describe('resolveWhisperPortkeyVirtualKey', () => {
    it('does not use the Azure chat virtual key', () => {
      const key = resolveWhisperPortkeyVirtualKey({
        AZURE_OPENAI_API_KEY: 'azure-vk-gpt-5-mini',
        PORTKEY_API_KEY: 'pk-xxx',
      });
      expect(key).toBeUndefined();
    });

    it('uses PORTKEY_VIRTUAL_KEY_OPENAI for Whisper', () => {
      const key = resolveWhisperPortkeyVirtualKey({
        AZURE_OPENAI_API_KEY: 'azure-vk-gpt-5-mini',
        PORTKEY_VIRTUAL_KEY_OPENAI: 'openai-vk',
      });
      expect(key).toBe('openai-vk');
    });
  });

  describe('buildTranscriptionPlan', () => {
    it('plans Gemini before Whisper and skips Azure Portkey', () => {
      const plan = buildTranscriptionPlan({
        GEMINI_API_KEY: 'gemini-key',
        PORTKEY_API_KEY: 'pk-xxx',
        AZURE_OPENAI_API_KEY: 'azure-vk-gpt-5-mini',
      });

      expect(plan.map((step) => `${step.provider}:${step.model}`)).toEqual([
        'gemini:gemini-2.5-flash',
        'gemini:gemini-2.0-flash',
      ]);
      expect(plan.some((step) => step.provider === 'portkey-openai')).toBe(false);
    });

    it('includes native OpenAI Whisper and OpenAI Portkey virtual key', () => {
      const plan = buildTranscriptionPlan({
        OPENAI_API_KEY: 'sk-xxx',
        PORTKEY_API_KEY: 'pk-xxx',
        PORTKEY_VIRTUAL_KEY_OPENAI: 'openai-vk',
        VERCEL_AI_GATEWAY_OPENAI: 'https://gateway.example',
        VERCEL_AI_GATEWAY_API_KEY: 'gw-key',
      });

      expect(plan).toEqual([
        { provider: 'openai-direct', model: WHISPER_MODEL },
        { provider: 'vercel-gateway', model: WHISPER_MODEL },
        { provider: 'portkey-openai', model: WHISPER_MODEL, virtualKey: 'openai-vk' },
      ]);
    });
  });

  describe('mime helpers', () => {
    it('normalizes Twilio ogg codecs and octet-stream', () => {
      expect(normalizeAudioMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg');
      expect(normalizeAudioMimeType('application/octet-stream')).toBe('audio/ogg');
      expect(normalizeAudioMimeType('audio/mpeg')).toBe('audio/mp3');
    });

    it('maps mime types to Whisper file extensions', () => {
      expect(whisperFileExtension('audio/ogg; codecs=opus')).toBe('ogg');
      expect(whisperFileExtension('audio/webm')).toBe('webm');
      expect(whisperFileExtension('audio/mpeg')).toBe('mp3');
    });
  });
});
