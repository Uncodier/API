import { randomBytes } from 'node:crypto';
import { generateAudioTool, type GenerateAudioToolParams } from '../assistantProtocol';
import { CreditService } from '@/lib/services/billing/CreditService';

const mockUpload = jest.fn();
const mockPublicUrl = jest.fn();
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
  });

  it.each([
    { provider: 'openrouter' },
    { format: 'ogg' },
    { model: 'vendor/tts-hd' },
    { voice: ' ' },
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
});