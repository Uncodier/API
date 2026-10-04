import 'openai/shims/web';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { GET, POST } from '../route';

jest.mock('openai', () => {
  const Actual = jest.requireActual('openai').default;
  return { __esModule: true, default: jest.fn((options: object) => new Actual({
    ...options, fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
  })) };
});
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
    process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
  });
  afterAll(() => { process.env = originalEnv; jest.restoreAllMocks(); });

  it('defaults to OpenRouter and returns binary MP3 with correct headers', async () => {
    fetchMock.mockResolvedValue(new Response('audio-data'));
    const result = await post({ text: 'Hello' });
    expect(result.status).toBe(200);
    expect(result.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(result.headers.get('Content-Length')).toBe('10');
    expect(result.headers.get('X-TTS-Provider')).toBe('openrouter');
    expect(await result.text()).toBe('audio-data');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/audio/speech');
  });

  it.each(['azure', 'gemini', 'vercel'])('rejects explicit direct provider %s', async provider => {
    expect((await post({ text: 'Hola', provider })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires OpenRouter credentials and ignores legacy provider keys', async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.AZURE_TTS_API_KEY = randomBytes(24).toString('hex');
    process.env.GEMINI_API_KEY = randomBytes(24).toString('hex');
    expect((await post({ text: 'Hola' })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { text: '' }, { text: 'Hello', provider: 'unsupported' }, { text: 'Hello', model: 123 },
    { text: 'Hello', format: 'invalid' }, { text: 'Hello', speed: 10 }, { text: 'Hello', model: 'tts-hd' },
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
    expect(body).not.toContain(process.env.OPENROUTER_API_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('describes a single gateway, defaults and no Azure environment requirement', async () => {
    const body = await (await GET()).json();
    expect(body.providers).toEqual(['openrouter']);
    expect(body.env.required).toEqual(['OPENROUTER_API_KEY']);
    expect(body.defaults.model).toBe('microsoft/mai-voice-2.1');
    expect(body.defaults.voice).toBe('es-MX-Valeria:MAI-Voice-2.1');
  });
});
