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
      SERVICE_API_KEY: randomBytes(24).toString('hex') };
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('audio', {
      headers: { 'Content-Type': 'audio/mpeg' },
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => { process.env = originalEnv; jest.restoreAllMocks(); });

  it('routes speech through OpenRouter by default and stores MP3', async () => {
    const result = await generateAudioTool('site-offline').execute({ text: 'Hello', model: 'microsoft/mai-voice-2.1' });
    expect(result).toMatchObject({ success: true, provider: 'openrouter', mimeType: 'audio/mpeg' });
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(request.url).toBe('https://example.invalid/api/ai/audio');
    expect(request.headers.get('x-api-key')).toBe(process.env.SERVICE_API_KEY);
    expect(await request.json()).toEqual({ text: 'Hello', provider: 'openrouter', model: 'microsoft/mai-voice-2.1', format: 'mp3' });
    const bucket = supabaseAdmin.storage.from('assets') as unknown as { upload: jest.Mock };
    expect(bucket.upload).toHaveBeenCalledWith(expect.stringMatching(/\.mp3$/), expect.any(Blob), { contentType: 'audio/mpeg' });
  });

  it('forces only MP3 for WhatsApp, not provider/model/voice or caller argument mutation', async () => {
    const args: GenerateAudioToolParams = { text: 'Hello', provider: 'openrouter', model: 'vendor/speech', voice: 'nova', format: 'pcm' };
    const result = await generateAudioTool('site-offline', undefined, { forceWhatsAppCompatible: true }).execute(args);
    expect(result).toMatchObject({ success: true, provider: 'openrouter', mimeType: 'audio/mpeg' });
    expect(args.format).toBe('pcm');
    const request = new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(await request.json()).toEqual({ ...args, format: 'mp3' });
  });

  it('ignores the old provider selector and exposes only OpenRouter', async () => {
    process.env.AI_TTS_PROVIDER = 'azure';
    const tool = generateAudioTool('site-offline');
    expect(tool.parameters.properties.provider.enum).toEqual(['openrouter']);
    const result = await tool.execute({ text: 'Hello' });
    expect(result.provider).toBe('openrouter');
  });
});