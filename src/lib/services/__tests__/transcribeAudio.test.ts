import { randomBytes } from 'node:crypto';
import 'openai/shims/web';
import {
  buildTranscriptionPlan, normalizeAudioMimeType,
  transcribeAudioBuffer,
} from '@/lib/services/ai/transcribeAudio';
import { recordTelemetry } from '@/lib/status/telemetry';

jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/services/twilio/fetchTwilioMedia', () => ({ fetchTwilioMedia: jest.fn(), isTwilioMediaUrl: jest.fn() }));
jest.mock('openai', () => {
  const Actual = jest.requireActual('openai').default;
  const Constructor = jest.fn((options: object) => new Actual({
    ...options, fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
  }));
  return { __esModule: true, default: Object.assign(Constructor, { toFile: Actual.toFile }) };
});

const syntheticKey = () => randomBytes(24).toString('hex');

describe('transcribeAudio helpers', () => {
  it('never uses legacy transcription provider selectors or credentials', () => {
    expect(buildTranscriptionPlan({ AI_TRANSCRIPTION_PROVIDER: 'gemini', GEMINI_API_KEY: syntheticKey() })).toEqual([]);
    expect(buildTranscriptionPlan({ AI_TRANSCRIPTION_PROVIDER: 'gemini', OPENROUTER_API_KEY: syntheticKey(),
      OPENROUTER_TRANSCRIPTION_MODEL: 'vendor/stt', GEMINI_API_KEY: syntheticKey() }))
      .toEqual([{ provider: 'openrouter', model: 'vendor/stt' }]);
  });

  it('never selects Portkey or reuses Azure chat virtual keys', () => {
    expect(buildTranscriptionPlan({
      PORTKEY_API_KEY: syntheticKey(), PORTKEY_VIRTUAL_KEY_OPENAI: syntheticKey(),
      AZURE_OPENAI_API_KEY: syntheticKey(),
    })).toEqual([]);
  });

  it('requires a qualified OpenRouter model AND key, never guessing a transcription model', () => {
    expect(buildTranscriptionPlan({ OPENROUTER_API_KEY: syntheticKey() })).toEqual([]);
    expect(buildTranscriptionPlan({ OPENROUTER_TRANSCRIPTION_MODEL: 'vendor/stt' })).toEqual([]);
    expect(buildTranscriptionPlan({ OPENROUTER_API_KEY: syntheticKey(), OPENROUTER_TRANSCRIPTION_MODEL: 'whisper-1' })).toEqual([]);
  });

  it('selects only configured OpenRouter even if all legacy credentials exist', () => {
    expect(buildTranscriptionPlan({
      OPENROUTER_API_KEY: syntheticKey(), OPENROUTER_TRANSCRIPTION_MODEL: 'vendor/stt',
      GEMINI_API_KEY: syntheticKey(), OPENAI_API_KEY: syntheticKey(),
      VERCEL_AI_GATEWAY_OPENAI: 'https://gateway.example.invalid', VERCEL_AI_GATEWAY_API_KEY: syntheticKey(),
    })).toEqual([{ provider: 'openrouter', model: 'vendor/stt' }]);
  });

  it('normalizes Twilio MIME types and maps extensions without losing FLAC/AAC', () => {
    expect(normalizeAudioMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(normalizeAudioMimeType('application/octet-stream')).toBe('audio/ogg');
    expect(normalizeAudioMimeType('audio/mpeg')).toBe('audio/mp3');
  });
});

describe('OpenRouter transcription adapter', () => {
  let fetchMock: jest.SpyInstance;
  let env: NodeJS.Dict<string>;
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    env = {
      OPENROUTER_API_KEY: syntheticKey(), OPENROUTER_TRANSCRIPTION_MODEL: 'vendor/configured-stt',
      OPENAI_API_KEY: syntheticKey(), GEMINI_API_KEY: syntheticKey(),
      PORTKEY_API_KEY: syntheticKey(), AZURE_OPENAI_API_KEY: syntheticKey(),
    };
  });
  afterAll(() => jest.restoreAllMocks());

  it('posts base64 JSON to /audio/transcriptions and preserves text, actual cost and generation ID', async () => {
    const usage = { cost: 0.0123, input_tokens: 10, output_tokens: 3 };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: '  Transcript.  ', usage }), {
      headers: { 'Content-Type': 'application/json', 'X-Generation-Id': 'offline-generation' },
    }));
    const buffer = Buffer.from('offline audio');
    const result = await transcribeAudioBuffer({ buffer, contentType: 'audio/ogg; codecs=opus' }, env);
    expect(result).toEqual({ success: true, text: 'Transcript.', provider: 'openrouter',
      model: 'vendor/configured-stt', usage, generationId: 'offline-generation' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(request.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(request.headers.get('authorization')).toBe(`Bearer ${env.OPENROUTER_API_KEY}`);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('x-portkey-api-key')).toBeNull();
    expect(await request.json()).toEqual({ model: 'vendor/configured-stt',
      input_audio: { data: buffer.toString('base64'), format: 'ogg' } });
  });

  it.each(['audio/mpeg', 'audio/mp4', 'audio/flac', 'audio/aac'])('maps %s to the declared audio format', async (mime) => {
    fetchMock.mockResolvedValue(Response.json({ text: 'Transcript' }));
    await transcribeAudioBuffer({ buffer: Buffer.from('audio'), contentType: mime }, env);
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    const expected: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/aac': 'aac' };
    expect((await request.json()).input_audio.format).toBe(expected[mime]);
  });

  it('fails closed with no network when model is unselected', async () => {
    delete env.OPENROUTER_TRANSCRIPTION_MODEL;
    const result = await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, env);
    expect(result.success).toBe(false);
    expect(result.error).toContain('OPENROUTER_TRANSCRIPTION_MODEL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry/fall back or leak upstream credentials on configured OpenRouter failure', async () => {
    const errorSecret = syntheticKey();
    fetchMock.mockResolvedValue(Response.json({ error: { message: `${errorSecret} ${env.OPENROUTER_API_KEY}` } }, { status: 503 }));
    const result = await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, env);
    expect(result).toMatchObject({ success: false, provider: 'openrouter', error: 'Configured audio transcription provider failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const exposed = JSON.stringify([result, jest.mocked(console.warn).mock.calls, jest.mocked(recordTelemetry).mock.calls]);
    for (const value of [errorSecret, ...Object.values(env).filter((value) => value !== env.OPENROUTER_TRANSCRIPTION_MODEL)]) {
      expect(exposed).not.toContain(value);
    }
  });

  it('rejects unknown formats without falsely labeling audio as MP3', async () => {
    const result = await transcribeAudioBuffer({ buffer: Buffer.from('audio'), contentType: 'audio/unknown' }, env);
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects empty transcription without switching account', async () => {
    fetchMock.mockResolvedValue(Response.json({ text: '  ' }));
    expect((await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, env)).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale OpenAI-direct selector without leaving OpenRouter', async () => {
    env.AI_TRANSCRIPTION_PROVIDER = 'openai-direct';
    fetchMock.mockResolvedValue(Response.json({ text: 'Transcript' }));
    const result = await transcribeAudioBuffer({ buffer: Buffer.from('audio'), contentType: 'audio/wav' }, env);
    expect(result).toMatchObject({ success: true, provider: 'openrouter', model: 'vendor/configured-stt' });
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(request.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(request.headers.get('authorization')).toBe(`Bearer ${env.OPENROUTER_API_KEY}`);
    expect(request.headers.get('content-type')).toBe('application/json');
  });
});
