import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { GET, POST } from '../route';

jest.mock('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit: jest.fn().mockResolvedValue(null),
  getAuthenticatedRateIdentity: jest.fn().mockReturnValue('offline-user'),
  isInternalServiceRequest: jest.fn().mockReturnValue(false),
}));

describe('audio route routing contract', () => {
  const originalEnv = process.env;
  let fetchMock: jest.SpyInstance;
  const post = (body: unknown) => POST(new NextRequest('https://example.invalid/api/ai/audio', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = { NODE_ENV: 'test', AZURE_TTS_API_KEY: randomBytes(24).toString('hex'),
      AZURE_TTS_ENDPOINT: 'https://speech.openai.azure.com' };
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
  });
  afterAll(() => { process.env = originalEnv; jest.restoreAllMocks(); });

  it('defaults to direct Azure and returns binary MP3 with correct headers', async () => {
    fetchMock.mockResolvedValue(new Response('audio-data', { headers: { 'Content-Type': 'audio/mpeg' } }));
    const result = await post({ text: 'Hello' });
    expect(result.status).toBe(200);
    expect(result.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(result.headers.get('Content-Length')).toBe('10');
    expect(result.headers.get('X-TTS-Provider')).toBe('azure');
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.text()).toBe('audio-data');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://speech.openai.azure.com/openai/deployments/tts-hd/audio/speech?api-version=2025-04-01-preview');
  });

  it.each(['openrouter', 'gemini', 'vercel'])('rejects unsupported provider %s', async provider => {
    expect((await post({ text: 'Hola', provider })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires Azure credentials without gateway fallback', async () => {
    delete process.env.AZURE_TTS_API_KEY;
    process.env.OPENROUTER_API_KEY = randomBytes(24).toString('hex');
    process.env.GEMINI_API_KEY = randomBytes(24).toString('hex');
    expect((await post({ text: 'Hola' })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { text: '' }, { text: 'Hello', provider: 'unsupported' }, { text: 'Hello', model: 123 },
    { text: 'Hello', format: 'invalid' }, { text: 'Hello', speed: 10 }, { text: 'Hello', model: 'vendor/speech' },
    { text: 'Hello', language: 'unsupported' }, { text: 'Hello', language: 123 }, { text: 'Hello', voice: 'unsupported' },
  ])('validates bad request before network access: %j', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not leak provider response bodies or credentials on failure', async () => {
    const secret = randomBytes(24).toString('hex');
    fetchMock.mockResolvedValue(new Response(secret, { status: 401 }));
    const response = await post({ text: 'Hello' });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain(process.env.AZURE_TTS_API_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('describes direct Azure defaults and dedicated environment requirements', async () => {
    const body = await (await GET()).json();
    expect(body.providers).toEqual(['azure']);
    expect(body.env.required).toEqual(['AZURE_TTS_ENDPOINT', 'AZURE_TTS_API_KEY']);
    expect(body.defaults.model).toBe('tts-hd');
    expect(body.defaults.voice).toBe('alloy');
    expect(body.defaults.language).toBe('auto');
    expect(body.options.voices).toEqual(['auto', 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    expect(body.options.languages).toContain('es');
    expect(body.notes.maxCharacters).toBe(4096);
  });

  it('accepts selected voice/language while Azure receives only supported synthesis fields', async () => {
    fetchMock.mockResolvedValue(new Response('audio-data', { headers: { 'Content-Type': 'audio/mpeg' } }));
    const response = await post({ text: 'Hola mundo', voice: 'shimmer', language: 'es' });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-TTS-Text-Language')).toBe('es');
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(await request.json()).toEqual({ input: 'Hola mundo', voice: 'shimmer', model: 'tts-hd', response_format: 'mp3' });
  });

  it('rejects overlong text and malformed JSON before network access', async () => {
    expect((await post({ text: 'a'.repeat(4097) })).status).toBe(413);
    expect((await POST(new NextRequest('https://example.invalid/api/ai/audio', { method: 'POST', body: '{' }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
