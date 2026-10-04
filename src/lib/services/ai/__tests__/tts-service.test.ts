import { randomBytes } from 'node:crypto';
import 'openai/shims/web';
import { synthesizeWithOpenRouter, synthesizeSpeech } from '../tts-service';
import { DEFAULT_OPENROUTER_TTS_MODEL, DEFAULT_OPENROUTER_TTS_VOICE } from '../openrouter';

jest.mock('openai', () => {
  const Actual = jest.requireActual('openai').default;
  return { __esModule: true, default: jest.fn((options: object) => new Actual({
    ...options, fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
  })) };
});

describe('OpenRouter-only speech', () => {
  const originalEnv = process.env;
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex'),
      AZURE_TTS_API_KEY: randomBytes(24).toString('hex'), GEMINI_API_KEY: randomBytes(24).toString('hex'),
      AI_TTS_PROVIDER: 'azure', AZURE_TTS_ENDPOINT: 'https://azure.example.invalid' };
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
  });
  afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

  it('uses Spanish MAI voice via the same gateway despite stale Azure config', async () => {
    fetchMock.mockResolvedValue(new Response('audio-data'));
    const result = await synthesizeSpeech({ text: 'Hola, tu pedido cuesta 250 pesos.' });
    expect(result).toMatchObject({ provider: 'openrouter', format: 'mp3', mimeType: 'audio/mpeg', audio: Buffer.from('audio-data') });
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(request.url).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(request.headers.get('authorization')).toBe(`Bearer ${process.env.OPENROUTER_API_KEY}`);
    expect(request.headers.get('api-key')).toBeNull();
    expect(await request.json()).toEqual({ input: 'Hola, tu pedido cuesta 250 pesos.',
      model: DEFAULT_OPENROUTER_TTS_MODEL, voice: DEFAULT_OPENROUTER_TTS_VOICE, response_format: 'mp3' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires only OpenRouter credentials and never falls back to Azure', async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(synthesizeSpeech({ text: 'Hola' })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['azure', 'gemini', 'vercel'])('rejects legacy provider %s before a request', async provider => {
    await expect(synthesizeSpeech({ text: 'Hola', provider: provider as any })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports model+voice overrides without an Azure deployment or invented voice mapping', async () => {
    process.env.OPENROUTER_TTS_MODEL = 'vendor/speech';
    process.env.OPENROUTER_TTS_VOICE = 'spanish-voice';
    fetchMock.mockResolvedValue(new Response('pcm-data'));
    await synthesizeSpeech({ text: 'Hola', format: 'pcm', speed: 1 });
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(await request.json()).toEqual({ input: 'Hola', model: 'vendor/speech', voice: 'spanish-voice', response_format: 'pcm', speed: 1 });
  });

  it('requires a compatible explicit voice when changing the default model', async () => {
    await expect(synthesizeWithOpenRouter('Hola', undefined, 'mp3', 'vendor/speech')).rejects.toThrow('OPENROUTER_TTS_VOICE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['wav', 'ogg', 'opus', 'aac', 'flac', 'invalid'])('rejects unsupported %s rather than mislabeling bytes', async format => {
    await expect(synthesizeWithOpenRouter('Hola', undefined, format)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds input/model/speed before network access', async () => {
    await expect(synthesizeWithOpenRouter(' ')).rejects.toThrow('input');
    await expect(synthesizeWithOpenRouter('a'.repeat(20001))).rejects.toThrow('20000');
    await expect(synthesizeWithOpenRouter('Hola', undefined, 'mp3', 'tts-hd')).rejects.toThrow('qualified');
    await expect(synthesizeWithOpenRouter('Hola', undefined, 'mp3', undefined, 4.1)).rejects.toThrow('speed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not leak upstream secrets, retry or switch accounts on failure', async () => {
    const secret = randomBytes(24).toString('hex');
    fetchMock.mockResolvedValue(Response.json({ error: { message: `${secret} ${process.env.OPENROUTER_API_KEY}` } }, { status: 503 }));
    const error = await synthesizeSpeech({ text: 'Hola' }).catch(error => error);
    expect(String(error)).toContain('OpenRouter TTS request failed');
    for (const value of [secret, process.env.OPENROUTER_API_KEY, process.env.AZURE_TTS_API_KEY, process.env.GEMINI_API_KEY]) {
      expect(String(error)).not.toContain(value);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects empty provider audio', async () => {
    fetchMock.mockResolvedValue(new Response(''));
    await expect(synthesizeSpeech({ text: 'Hola' })).rejects.toThrow('empty audio');
  });
});
