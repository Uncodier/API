import { randomBytes } from 'node:crypto';
import { buildTranscriptionPlan, normalizeAudioMimeType, transcribeAudioBuffer } from '@/lib/services/ai/transcribeAudio';
import { getAzureTranscriptionConfig } from '@/lib/services/ai/azure-transcription-config';
import { recordTelemetry } from '@/lib/status/telemetry';

jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/services/twilio/fetchTwilioMedia', () => ({ fetchTwilioMedia: jest.fn(), isTwilioMediaUrl: jest.fn() }));

const syntheticKey = () => randomBytes(24).toString('hex');
const azureEnv = (): NodeJS.Dict<string> => ({
  MICROSOFT_AZURE_OPENAI_ENDPOINT: 'https://test-resource.openai.azure.com',
  MICROSOFT_AZURE_OPENAI_API_KEY: syntheticKey(),
  AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT: 'test-transcribe',
});

describe('Azure transcription configuration', () => {
  it('selects only the explicit Azure transcription deployment, not chat or routed credentials', () => {
    expect(buildTranscriptionPlan({ ...azureEnv(), MICROSOFT_AZURE_OPENAI_DEPLOYMENT: 'chat',
      OPENROUTER_API_KEY: syntheticKey(), OPENROUTER_TRANSCRIPTION_MODEL: 'vendor/stt',
      AI_TRANSCRIPTION_PROVIDER: 'gemini', GEMINI_API_KEY: syntheticKey() }))
      .toEqual([{ provider: 'azure-direct', model: 'test-transcribe' }]);
    expect(buildTranscriptionPlan({ OPENROUTER_API_KEY: syntheticKey(), OPENROUTER_TRANSCRIPTION_MODEL: 'vendor/stt',
      PORTKEY_API_KEY: syntheticKey(), PORTKEY_VIRTUAL_KEY_OPENAI: syntheticKey(),
      OPENAI_API_KEY: syntheticKey(), GEMINI_API_KEY: syntheticKey(),
      VERCEL_AI_GATEWAY_OPENAI: 'https://gateway.example.invalid', VERCEL_AI_GATEWAY_API_KEY: syntheticKey() })).toEqual([]);
  });

  it.each(['MICROSOFT_AZURE_OPENAI_ENDPOINT', 'MICROSOFT_AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT'])
    ('requires %s without guessing a deployment', (name) => {
      const env = azureEnv(); delete env[name];
      expect(buildTranscriptionPlan(env)).toEqual([]);
    });

  it('supports generic Azure credentials and independent transcription overrides', () => {
    const key = syntheticKey();
    expect(getAzureTranscriptionConfig({ AZURE_OPENAI_ENDPOINT: 'https://generic.openai.azure.com',
      AZURE_OPENAI_API_KEY: key, AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT: 'stt' }))
      .toEqual({ origin: 'https://generic.openai.azure.com', apiKey: key, deployment: 'stt', apiVersion: '2024-10-21' });
    expect(getAzureTranscriptionConfig({ ...azureEnv(),
      AZURE_OPENAI_TRANSCRIPTION_ENDPOINT: 'https://dedicated.services.ai.azure.com/openai/v1/',
      AZURE_OPENAI_TRANSCRIPTION_API_KEY: key, AZURE_OPENAI_TRANSCRIPTION_API_VERSION: 'v1',
      MICROSOFT_AZURE_OPENAI_API_VERSION: 'chat-version' }))
      .toEqual({ origin: 'https://dedicated.services.ai.azure.com', apiKey: key, deployment: 'test-transcribe', apiVersion: 'v1' });
  });

  it.each(['AZURE_OPENAI_TRANSCRIPTION_ENDPOINT', 'AZURE_OPENAI_TRANSCRIPTION_API_KEY', 'AZURE_OPENAI_TRANSCRIPTION_API_VERSION'])
    ('fails closed on an explicit empty %s override', (name) => {
      expect(buildTranscriptionPlan({ ...azureEnv(), [name]: ' ' })).toEqual([]);
    });

  it.each([
    ['AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT', 'vendor/stt'],
    ['AZURE_OPENAI_TRANSCRIPTION_API_VERSION', 'invalid-version'],
  ])('rejects invalid %s', (name, value) => {
    expect(buildTranscriptionPlan({ ...azureEnv(), [name]: value })).toEqual([]);
  });

  it('normalizes WhatsApp OGG and common MIME aliases', () => {
    expect(normalizeAudioMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(normalizeAudioMimeType('application/octet-stream')).toBe('audio/ogg');
    expect(normalizeAudioMimeType('audio/mpeg')).toBe('audio/mp3');
    expect(normalizeAudioMimeType('audio/x-wav')).toBe('audio/wav');
  });
});

describe('Azure direct transcription adapter', () => {
  let fetchMock: jest.SpyInstance;
  let env: NodeJS.Dict<string>;
  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    env = { ...azureEnv(), OPENROUTER_API_KEY: syntheticKey(), OPENROUTER_TRANSCRIPTION_MODEL: 'vendor/stt',
      OPENAI_API_KEY: syntheticKey(), GEMINI_API_KEY: syntheticKey(), PORTKEY_API_KEY: syntheticKey() };
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('uploads original OGG bytes as multipart to Azure with no gateway headers or invented cost', async () => {
    const buffer = Buffer.from('test OGG bytes');
    fetchMock.mockResolvedValue(Response.json({ text: ' Transcripción ', usage: { duration: 2 } },
      { headers: { 'apim-request-id': 'azure-request' } }));
    const result = await transcribeAudioBuffer({ buffer, contentType: 'audio/ogg; codecs=opus' }, env);
    expect(result).toMatchObject({ success: true, text: 'Transcripción', provider: 'azure-direct',
      model: 'test-transcribe', generationId: 'azure-request', usage: { duration: 2 } });
    expect(result.usage?.cost).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(request.url).toBe('https://test-resource.openai.azure.com/openai/deployments/test-transcribe/audio/transcriptions?api-version=2024-10-21');
    expect(request.headers.get('api-key')).toBe(env.MICROSOFT_AZURE_OPENAI_API_KEY);
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.headers.get('x-portkey-api-key')).toBeNull();
    expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    const form = await request.formData();
    expect(form.get('model')).toBe('test-transcribe'); expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.ogg'); expect(file.type).toBe('audio/ogg');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(buffer);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([['audio/mpeg', 'mp3'], ['audio/mp4', 'm4a'], ['audio/flac', 'flac'], ['audio/aac', 'aac'],
    ['audio/x-wav', 'wav'], ['audio/webm', 'webm'], ['application/ogg', 'ogg']])
    ('preserves %s with a matching file extension', async (mime, extension) => {
      fetchMock.mockResolvedValue(Response.json({ text: 'Transcript' }));
      await transcribeAudioBuffer({ buffer: Buffer.from('audio'), contentType: mime }, env);
      expect(((fetchMock.mock.calls[0][1].body as FormData).get('file') as File).name).toBe(`audio.${extension}`);
    });

  it.each(['v1', 'preview', '2025-03-01-preview'])('uses the explicitly configured %s API', async (version) => {
    env.AZURE_OPENAI_TRANSCRIPTION_API_VERSION = version;
    fetchMock.mockResolvedValue(Response.json({ text: 'Transcript' }));
    await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, env);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe(version.includes('-') ? '/openai/deployments/test-transcribe/audio/transcriptions' : '/openai/v1/audio/transcriptions');
    expect(url.searchParams.get('api-version')).toBe(version === 'v1' ? null : version);
  });

  it('fails without network when Azure is not configured, even when OpenRouter is', async () => {
    delete env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT;
    const result = await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, env);
    expect(result.success).toBe(false); expect(result.error).toContain('AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry, fall back or expose credentials/audio when Azure fails', async () => {
    const secret = syntheticKey(); const buffer = Buffer.from(syntheticKey());
    fetchMock.mockResolvedValue(Response.json({ error: { message: `${secret} ${buffer} ${env.MICROSOFT_AZURE_OPENAI_API_KEY}` } }, { status: 503 }));
    const result = await transcribeAudioBuffer({ buffer }, env);
    expect(result).toMatchObject({ success: false, provider: 'azure-direct', error: 'Configured audio transcription provider failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const exposed = JSON.stringify([result, jest.mocked(console.log).mock.calls, jest.mocked(console.warn).mock.calls, jest.mocked(recordTelemetry).mock.calls]);
    for (const value of [secret, buffer.toString(), ...Object.entries(env).filter(([name]) => name.endsWith('_KEY')).map(([, value]) => value!)]) {
      expect(exposed).not.toContain(value);
    }
  });

  it('rejects credential-bearing endpoints without leaking or fetching', async () => {
    const url = new URL('https://config.example.invalid');
    url.username = syntheticKey(); url.password = syntheticKey();
    env.AZURE_OPENAI_TRANSCRIPTION_ENDPOINT = url.toString();
    const result = await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, env);
    for (const value of [url.username, url.password, url.toString()]) expect(JSON.stringify(result)).not.toContain(value);
    expect(result.success).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['http://test.openai.azure.com', 'https://openrouter.ai', 'https://test.openai.azure.com/evil',
    'https://test.openai.azure.com?key=unsafe'])('rejects unsafe endpoint %s', async (endpoint) => {
      env.AZURE_OPENAI_TRANSCRIPTION_ENDPOINT = endpoint;
      expect((await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, env)).success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it.each([0, 25 * 1024 * 1024 + 1])('rejects invalid audio size %i', async (size) => {
    const buffer = Buffer.alloc(size);
    expect((await transcribeAudioBuffer({ buffer }, env)).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown formats without relabeling or fetching', async () => {
    expect((await transcribeAudioBuffer({ buffer: Buffer.from('audio'), contentType: 'audio/unknown' }, env)).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects empty transcription without switching provider', async () => {
    fetchMock.mockResolvedValue(Response.json({ text: '  ' }));
    expect((await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, env)).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});