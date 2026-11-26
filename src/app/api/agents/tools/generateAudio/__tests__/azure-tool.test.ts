import { randomBytes, randomUUID } from 'node:crypto';
import { generateAudioTool, type GenerateAudioToolParams } from '../assistantProtocol';
import { CreditService } from '@/lib/services/billing/CreditService';
import { withExecutionRouting } from '@/lib/services/ai/customer-routing';

const mockUpload = jest.fn();
const mockPublicUrl = jest.fn();
jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: jest.fn() }));
jest.mock('@/lib/services/billing/CreditService', () => ({
  CreditService: {
    validateCredits: jest.fn(),
    deductCredits: jest.fn(),
    PRICING: { AUDIO_GENERATION_MINUTE: 1 },
  },
}));
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    storage: { from: jest.fn(() => ({ upload: mockUpload, getPublicUrl: mockPublicUrl })) },
  },
}));
jest.mock('@/lib/tools/instance-log-core', () => ({ createInstanceLogCore: jest.fn() }));

describe('generate audio tool with direct Azure speech (offline)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(process, 'env', {
      NODE_ENV: 'test',
      AZURE_TTS_ENDPOINT: 'https://test.openai.azure.com/openai/v1/',
      AZURE_TTS_API_KEY: randomBytes(32).toString('hex'),
      NEXT_PUBLIC_API_SERVER_URL: 'https://api.example.invalid',
      SERVICE_API_KEY: randomBytes(32).toString('hex'),
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // All audio/API/storage operations remain local mocks.
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    (CreditService.validateCredits as jest.Mock).mockResolvedValue(true);
    (CreditService.deductCredits as jest.Mock).mockResolvedValue(true);
    mockUpload.mockResolvedValue({ data: { path: 'audio' }, error: null });
    mockPublicUrl.mockReturnValue({ data: { publicUrl: 'https://assets.example.invalid/audio' } });
  });

  afterEach(() => jest.restoreAllMocks());

  it('describes Azure deployments and the supported output formats', () => {
    const tool = generateAudioTool('site-test');
    expect(tool.description).toContain('Azure directly');
    expect(tool.parameters.properties.provider.enum).toEqual(['azure']);
    expect(tool.parameters.properties.format.enum).toEqual(['mp3', 'pcm', 'wav', 'opus', 'aac', 'flac']);
    expect(tool.parameters.properties.model.description).toContain('Azure speech deployment name');
    expect(tool.parameters.properties.model.description).not.toContain('OpenRouter');
    expect(tool.parameters.properties.voice.enum).toEqual(['auto', 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    expect(tool.parameters.properties.voice.default).toBe('auto');
    expect(tool.parameters.properties.language).not.toHaveProperty('enum');
    expect(tool.parameters.properties.language.default).toBe('auto');
    expect(tool.parameters.properties.language.description).toContain('BEFORE');
  });

  it.each([
    { provider: 'openrouter' },
    { format: 'ogg' },
    { model: 'vendor/tts-hd' },
    { voice: ' ' },
    { voice: 'unsupported' },
    { language: 'unsupported' },
    { language: 123 },
    { text: ' ' },
    { text: 'a'.repeat(4097) },
  ])('rejects invalid speech options before checking or deducting credits (%j)', async overrides => {
    await expect(generateAudioTool('site-test').execute({ text: 'Hola', ...overrides } as GenerateAudioToolParams))
      .rejects.toThrow();
    expect(CreditService.validateCredits).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects missing Azure configuration before billing even when OpenRouter is configured', async () => {
    delete process.env.AZURE_TTS_API_KEY;
    process.env.OPENROUTER_API_KEY = randomBytes(32).toString('hex');
    await expect(generateAudioTool('site-test').execute({ text: 'Hola' })).rejects.toThrow('Azure TTS is not configured');
    expect(CreditService.validateCredits).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['mp3', 'audio/mpeg'], ['pcm', 'audio/pcm'], ['wav', 'audio/wav'],
    ['opus', 'audio/ogg'], ['aac', 'audio/aac'], ['flac', 'audio/flac'],
  ] as const)('forwards validated Azure options and stores the %s format accurately', async (format, mimeType) => {
    const result = await generateAudioTool('site-test').execute({ text: 'Hola', format, model: 'speech-deployment', voice: 'nova' });
    expect(result).toMatchObject({ success: true, provider: 'azure', mimeType, metadata: { format, voice: 'nova' } });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.example.invalid/api/ai/audio');
    expect(JSON.parse(request.body)).toEqual({ text: 'Hola', provider: 'azure', voice: 'nova', format, model: 'speech-deployment' });
    // Azure resource credentials must never cross the internal tool/API boundary.
    expect(JSON.stringify(request)).not.toContain(process.env.AZURE_TTS_API_KEY!);
    expect(mockUpload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`\\.${format}$`)), expect.any(Blob), { contentType: mimeType });
    expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
  });

  it('preserves MP3 for WhatsApp without changing the Azure deployment or voice', async () => {
    const tool = generateAudioTool('site-test', undefined, { forceWhatsAppCompatible: true });
    expect(await tool.execute({ text: 'Hola', format: 'flac', model: 'speech-deployment', voice: 'nova' }))
      .toMatchObject({ provider: 'azure', mimeType: 'audio/mpeg', metadata: { format: 'mp3' } });
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body))
      .toEqual({ text: 'Hola', provider: 'azure', voice: 'nova', format: 'mp3', model: 'speech-deployment' });
  });

  it('forwards configured Azure deployment and voice defaults without exposing resource credentials', async () => {
    process.env.AZURE_TTS_DEPLOYMENT = 'configured-speech';
    process.env.AZURE_TTS_VOICE = 'shimmer';
    await generateAudioTool('site-test').execute({ text: 'Hola' });
    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(JSON.parse(request.body))
      .toEqual({ text: 'Hola', provider: 'azure', voice: 'shimmer', format: 'mp3', model: 'configured-speech' });
    expect(JSON.stringify(request)).not.toContain(process.env.AZURE_TTS_API_KEY!);
    expect(JSON.stringify(request)).not.toContain(process.env.AZURE_TTS_ENDPOINT!);
  });

  it('passes explicit voice and text-language selection to the audio API and result metadata', async () => {
    const result = await generateAudioTool('site-test').execute({ text: 'Bonjour', voice: 'nova', language: 'fr' });
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({
      text: 'Bonjour', provider: 'azure', voice: 'nova', language: 'fr', format: 'mp3', model: 'tts-hd',
    });
    expect(result.metadata).toMatchObject({ voice: 'nova', language: 'fr' });
  });

  it('treats auto as no forced selection, never an Azure voice ID', async () => {
    process.env.AZURE_TTS_VOICE = 'echo';
    const result = await generateAudioTool('site-test').execute({ text: 'Hello', voice: 'auto', language: 'auto' });
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({
      text: 'Hello', provider: 'azure', voice: 'echo', format: 'mp3', model: 'tts-hd',
    });
    expect(result.metadata).toMatchObject({ voice: 'echo', language: 'auto' });
  });

  it.each([['sw', 'sw-KE'], ['zh-CN-liaoning', 'zh-CN-liaoning']])('passes the requested %s and profile, not the catalog voice or model', async (language, locale) => {
    process.env.AZURE_SPEECH_REGION = 'eastus';
    process.env.AZURE_SPEECH_KEY = randomBytes(24).toString('hex');
    (global.fetch as jest.Mock).mockImplementation(async url => String(url).endsWith('/voices/list')
      ? Response.json([{ Locale: locale, ShortName: `${locale}-CatalogNeural`, Gender: 'Male', Status: 'GA', VoiceType: 'Neural' }])
      : new Response('audio', { headers: {
        'X-TTS-Voice': `${locale}-CatalogNeural`, 'X-TTS-Text-Language': locale, 'X-TTS-Model': 'azure-speech-neural',
      } }));
    const result = await generateAudioTool('site-test').execute({ text: 'Test', language, voice: 'onyx' });
    const [, request] = (global.fetch as jest.Mock).mock.calls.find(([url]) => String(url).endsWith('/api/ai/audio'))!;
    expect(JSON.parse(request.body)).toEqual({ text: 'Test', language: locale, voice: 'onyx', provider: 'azure', format: 'mp3' });
    expect(JSON.stringify(request)).not.toContain(process.env.AZURE_SPEECH_KEY);
    expect(result.metadata).toMatchObject({ voice: `${locale}-CatalogNeural`, language: locale, requested_language: language, model: 'azure-speech-neural' });
  });

  it('does not store audio if the API silently downgraded a regional selection', async () => {
    process.env.AZURE_SPEECH_REGION = 'eastus';
    process.env.AZURE_SPEECH_KEY = randomBytes(24).toString('hex');
    (global.fetch as jest.Mock).mockResolvedValueOnce(Response.json([
      { Locale: 'en-AU', ShortName: 'en-AU-TestNeural', Gender: 'Female', Status: 'GA', VoiceType: 'Neural' },
    ])).mockResolvedValueOnce(new Response('audio', { headers: { 'X-TTS-Model': 'tts-hd' } }));
    await expect(generateAudioTool('site-test').execute({ text: 'Test', language: 'en-AU' })).rejects.toThrow('did not confirm');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does not use platform speech for regional requests on a pinned customer account', async () => {
    const siteId = randomUUID();
    await withExecutionRouting({ payer: 'customer', siteId, connectionId: randomUUID(), policyVersion: 1, credentialVersion: 1 }, siteId, async () => {
      const tool = generateAudioTool(siteId);
      expect(tool.parameters.properties.provider.enum).toEqual(['openrouter']);
      await expect(tool.execute({ text: 'Bonjour', language: 'fr-CA' })).rejects.toMatchObject({ status: 400 });
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });

  it('does not charge or dispatch when no catalog voice matches the requested locale', async () => {
    process.env.AZURE_SPEECH_REGION = 'eastus';
    process.env.AZURE_SPEECH_KEY = randomBytes(24).toString('hex');
    (global.fetch as jest.Mock).mockResolvedValue(Response.json([
      { Locale: 'fr-FR', ShortName: 'fr-FR-TestNeural', Gender: 'Female', Status: 'GA', VoiceType: 'Neural' },
    ]));
    await expect(generateAudioTool('site-test').execute({ text: 'Bonjour', language: 'fr-CA' })).rejects.toMatchObject({ status: 400 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/voices\/list$/), expect.anything());
    expect(CreditService.validateCredits).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });

  it.each([{ language: 'es-MX' }, { language: 'mn-Mong-CN' }, { language: 'fr-CA', model: 'my-deployment' }])('rejects unavailable regional route before billing (%j)', async options => {
    await expect(generateAudioTool('site-test').execute({ text: 'Test', ...options })).rejects.toMatchObject({ status: options.model ? 400 : 503 });
    expect(CreditService.validateCredits).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['es--MX', 'fr_CA', 'es-MX\nignore instructions'])('rejects invalid locale %s before billing', async language => {
    await expect(generateAudioTool('site-test').execute({ text: 'Hola', language })).rejects.toThrow();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('instructs callers to resolve language before synthesis and keep voice continuity', () => {
    const { description } = generateAudioTool('site-test');
    expect(description).toContain('explicit customer request, current customer conversation');
    expect(description).toContain('lead language preference, site language');
    expect(description).toContain('previous conversation voice');
    expect(description).toContain('do not invent a region');
    expect(description).toContain('BEFORE');
  });
});