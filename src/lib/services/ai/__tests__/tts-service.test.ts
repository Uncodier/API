import { randomBytes } from 'node:crypto';
import { synthesizeWithAzure, synthesizeSpeech } from '../tts-service';
import { getAzureTtsConfig } from '../azure-tts-config';

describe('direct Azure speech', () => {
  const originalEnv = process.env;
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    process.env = { NODE_ENV: 'test', AZURE_TTS_ENDPOINT: 'https://speech.cognitiveservices.azure.com',
      AZURE_TTS_API_KEY: randomBytes(24).toString('hex'), OPENROUTER_API_KEY: randomBytes(24).toString('hex'),
      GEMINI_API_KEY: randomBytes(24).toString('hex'), AI_TTS_PROVIDER: 'openrouter',
      OPENROUTER_TTS_MODEL: 'microsoft/mai-voice-2.1', OPENROUTER_TTS_VOICE: 'es-MX-Valeria:MAI-Voice-2.1' };
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
  });
  afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });
  const audioResponse = (data = 'audio-data') => new Response(data, { headers: { 'Content-Type': 'audio/mpeg' } });
  const sentRequest = () => new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);

  it('uses the dedicated Azure resource/key despite stale gateway configuration', async () => {
    fetchMock.mockResolvedValue(audioResponse());
    const result = await synthesizeSpeech({ text: 'Hola, tu pedido cuesta 250 pesos.' });
    expect(result).toMatchObject({ provider: 'azure', format: 'mp3', mimeType: 'audio/mpeg', audio: Buffer.from('audio-data') });
    const request = sentRequest();
    expect(request.url).toBe('https://speech.cognitiveservices.azure.com/openai/deployments/tts-hd/audio/speech?api-version=2025-04-01-preview');
    expect(request.headers.get('api-key')).toBe(process.env.AZURE_TTS_API_KEY);
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.redirect).toBe('error');
    expect(request.cache).toBe('no-store');
    expect(await request.json()).toEqual({ input: 'Hola, tu pedido cuesta 250 pesos.',
      model: 'tts-hd', voice: 'alloy', response_format: 'mp3' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('works with no OpenRouter credentials', async () => {
    delete process.env.OPENROUTER_API_KEY;
    fetchMock.mockResolvedValue(audioResponse());
    await expect(synthesizeSpeech({ text: 'Hola', provider: 'azure' })).resolves.toMatchObject({ provider: 'azure' });
  });

  it('accepts explicit language guidance without changing text or sending unsupported Azure fields', async () => {
    fetchMock.mockResolvedValue(audioResponse());
    const result = await synthesizeSpeech({ text: 'Bonjour, le monde.', voice: 'nova', language: 'fr' });
    expect(result.language).toBe('fr');
    expect(await sentRequest().json()).toEqual({
      input: 'Bonjour, le monde.', voice: 'nova', model: 'tts-hd', response_format: 'mp3',
    });
  });

  it('never forwards the auto sentinel to Azure', async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await synthesizeSpeech({ text: 'Hola', voice: 'auto', language: 'auto' });
    expect(await sentRequest().json()).toEqual({ input: 'Hola', voice: 'alloy', model: 'tts-hd', response_format: 'mp3' });
  });

  it.each(['AZURE_TTS_API_KEY', 'AZURE_TTS_ENDPOINT'])('fails closed without %s and never falls back', async name => {
    delete process.env[name];
    await expect(synthesizeSpeech({ text: 'Hola' })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['openrouter', 'gemini', 'vercel'])('rejects unsupported provider %s', async provider => {
    await expect(synthesizeSpeech({ text: 'Hola', provider: provider as any })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports dedicated deployment/version/voice overrides, never chat settings', async () => {
    Object.assign(process.env, { AZURE_TTS_ENDPOINT: 'https://speech.openai.azure.com/openai/v1/',
      AZURE_TTS_DEPLOYMENT: 'custom-speech', AZURE_TTS_API_VERSION: '2025-03-01-preview', AZURE_TTS_VOICE: 'nova',
      MICROSOFT_AZURE_OPENAI_DEPLOYMENT: 'chat-model', MICROSOFT_AZURE_OPENAI_API_VERSION: 'invalid' });
    fetchMock.mockResolvedValue(audioResponse());
    await synthesizeSpeech({ text: 'Hola', format: 'pcm', speed: 1 });
    const request = sentRequest();
    expect(request.url).toBe('https://speech.openai.azure.com/openai/deployments/custom-speech/audio/speech?api-version=2025-03-01-preview');
    expect(await request.json()).toEqual({ input: 'Hola', model: 'custom-speech', voice: 'nova', response_format: 'pcm', speed: 1 });
  });

  it.each([
    ['mp3', 'audio/mpeg'], ['pcm', 'audio/pcm'], ['wav', 'audio/wav'],
    ['opus', 'audio/ogg'], ['aac', 'audio/aac'], ['flac', 'audio/flac'],
  ])('preserves %s bytes and MIME %s without transcoding', async (format, mimeType) => {
    fetchMock.mockResolvedValue(new Response('bytes', { headers: { 'Content-Type': mimeType } }));
    expect(await synthesizeSpeech({ text: 'Hola', format: format as any })).toMatchObject({ format, mimeType, audio: Buffer.from('bytes') });
    expect(await sentRequest().json()).toMatchObject({ response_format: format });
  });

  it.each([
    { text: ' ' }, { text: 'a'.repeat(4097) }, { text: 'Hola', model: 'vendor/speech' },
    { text: 'Hola', voice: '' }, { text: 'Hola', format: 'ogg' }, { text: 'Hola', format: 'toString' },
    { text: 'Hola', voice: 'MAI-Voice' }, { text: 'Hola', language: 'unsupported' }, { text: 'Hola', language: null },
    { text: 'Hola', speed: 4.1 }, { text: 'Hola', speed: NaN }, { text: 'Hola', speed: '1' },
  ])('bounds options before network access', async options => {
    await expect(synthesizeSpeech(options as any)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the input/speed boundaries and an explicit deployment', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(audioResponse()));
    await synthesizeWithAzure('a'.repeat(4096), 'shimmer', 'mp3', 'other-speech', 0.25);
    expect(await sentRequest().json()).toMatchObject({ model: 'other-speech', voice: 'shimmer', speed: 0.25 });
    await synthesizeWithAzure('Hola', undefined, 'mp3', undefined, 4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    'http://speech.openai.azure.com', 'https://example.invalid', 'https://openrouter.ai/api/v1',
    'https://speech.openai.azure.com.evil.invalid', 'https://speech.openai.azure.com/other',
    'https://speech.openai.azure.com?key=value', 'https://speech.openai.azure.com#hash',
    'https://speech.openai.azure.com:8443',
  ])('rejects unsafe endpoint %s before forwarding credentials', async endpoint => {
    process.env.AZURE_TTS_ENDPOINT = endpoint;
    await expect(synthesizeSpeech({ text: 'Hola' })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never exposes authenticated configuration URLs or upstream secrets', async () => {
    const upstreamSecret = randomBytes(24).toString('hex');
    const url = new URL('https://config.example.invalid');
    url.username = randomBytes(12).toString('hex'); url.password = randomBytes(24).toString('hex');
    const configError = (() => { try { getAzureTtsConfig({ ...process.env, AZURE_TTS_ENDPOINT: url.toString() }); } catch (e) { return e; } })();
    for (const secret of [url.username, url.password, url.toString()]) expect(String(configError)).not.toContain(secret);
    fetchMock.mockResolvedValue(Response.json({ error: { message: `${upstreamSecret} ${process.env.AZURE_TTS_API_KEY}` } }, { status: 503 }));
    const error = await synthesizeSpeech({ text: 'Hola' }).catch(error => error);
    expect(String(error)).toContain('Azure TTS request failed (503)');
    for (const secret of [upstreamSecret, process.env.OPENROUTER_API_KEY, process.env.AZURE_TTS_API_KEY, process.env.GEMINI_API_KEY]) {
      expect(String(error)).not.toContain(secret);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['AZURE_TTS_DEPLOYMENT', 'AZURE_TTS_API_VERSION', 'AZURE_TTS_VOICE'])('rejects an empty explicit %s override', name => {
    process.env[name] = '';
    expect(() => getAzureTtsConfig()).toThrow('configuration');
  });

  it('sanitizes transport errors without retrying', async () => {
    const secret = randomBytes(24).toString('hex');
    fetchMock.mockRejectedValue(new Error(secret));
    const error = await synthesizeSpeech({ text: 'Hola' }).catch(error => error);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).toContain('Azure TTS request failed or timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects empty, JSON and oversized provider responses', async () => {
    fetchMock.mockResolvedValue(audioResponse(''));
    await expect(synthesizeSpeech({ text: 'Hola' })).rejects.toThrow('empty audio');
    fetchMock.mockResolvedValue(Response.json({ error: 'not audio' }));
    await expect(synthesizeSpeech({ text: 'Hola' })).rejects.toThrow('non-audio');
    fetchMock.mockResolvedValue(new Response('data', { headers: {
      'Content-Type': 'audio/mpeg', 'Content-Length': String(33 * 1024 * 1024),
    } }));
    await expect(synthesizeSpeech({ text: 'Hola' })).rejects.toThrow('Azure TTS request failed');
  });
});