import { randomBytes } from 'node:crypto';
import { generateAudioTool, GenerateAudioToolParams } from '@/app/api/agents/tools/generateAudio/assistantProtocol';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: {
  validateCredits: jest.fn().mockResolvedValue(true), deductCredits: jest.fn().mockResolvedValue(true),
  PRICING: { AUDIO_GENERATION_MINUTE: 1 },
} }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { storage: {
  from: jest.fn().mockReturnThis(), upload: jest.fn().mockResolvedValue({ error: null }),
  getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://example.invalid/audio.mp3' } }),
} } }));
jest.mock('@/lib/tools/instance-log-core', () => ({ createInstanceLogCore: jest.fn() }));

describe('generateAudio voice caller', () => {
  const originalEnv = process.env;
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    process.env = { NODE_ENV: 'test', NEXT_PUBLIC_API_SERVER_URL: 'https://example.invalid',
      SERVICE_API_KEY: randomBytes(24).toString('hex'),
      AZURE_TTS_ENDPOINT: 'https://test.openai.azure.com/openai/v1/',
      AZURE_TTS_API_KEY: randomBytes(32).toString('hex') };
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('audio', {
      headers: { 'Content-Type': 'audio/mpeg' },
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => { process.env = originalEnv; jest.restoreAllMocks(); });

  it('routes speech through Azure by default and stores MP3', async () => {
    const result = await generateAudioTool('site-offline').execute({ text: 'Hello', model: 'tts-hd' });
    expect(result).toMatchObject({ success: true, provider: 'azure', mimeType: 'audio/mpeg' });
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(request.url).toBe('https://example.invalid/api/ai/audio');
    expect(request.headers.get('x-api-key')).toBe(process.env.SERVICE_API_KEY);
    expect(await request.json()).toEqual({ text: 'Hello', provider: 'azure', model: 'tts-hd', voice: 'alloy', format: 'mp3' });
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain(process.env.AZURE_TTS_API_KEY!);
    const bucket = supabaseAdmin.storage.from('assets') as unknown as { upload: jest.Mock };
    expect(bucket.upload).toHaveBeenCalledWith(expect.stringMatching(/\.mp3$/), expect.any(Blob), { contentType: 'audio/mpeg' });
  });

  it('forces only MP3 for WhatsApp, not provider/model/voice or caller argument mutation', async () => {
    const args: GenerateAudioToolParams = { text: 'Hello', provider: 'azure', model: 'speech-deployment', voice: 'nova', format: 'pcm' };
    const result = await generateAudioTool('site-offline', undefined, { forceWhatsAppCompatible: true }).execute(args);
    expect(result).toMatchObject({ success: true, provider: 'azure', mimeType: 'audio/mpeg' });
    expect(args.format).toBe('pcm');
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(await request.json()).toEqual({ ...args, format: 'mp3' });
  });

  it('ignores the old provider selector and exposes only Azure', async () => {
    process.env.AI_TTS_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = randomBytes(32).toString('hex');
    process.env.OPENROUTER_TTS_MODEL = 'microsoft/mai-voice-2.1';
    process.env.AZURE_TTS_DEPLOYMENT = 'configured-speech';
    process.env.AZURE_TTS_VOICE = 'shimmer';
    const tool = generateAudioTool('site-offline');
    expect(tool.parameters.properties.provider.enum).toEqual(['azure']);
    const result = await tool.execute({ text: 'Hello' });
    expect(result.provider).toBe('azure');
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(await request.json()).toEqual({ text: 'Hello', provider: 'azure', model: 'configured-speech', voice: 'shimmer', format: 'mp3' });
  });
});