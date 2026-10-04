import { randomUUID } from 'node:crypto';
import { generateVideoTool, generateVideoToolScrapybara } from '../assistantProtocol';
import { generateImageTool, generateImageToolScrapybara } from '../../generateImage/assistantProtocol';
import { VideoGenerationService } from '@/lib/services/video/VideoGenerationService';
import { ImageGenerationService } from '@/lib/services/image/ImageGenerationService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createInstanceLogCore } from '@/lib/tools/instance-log-core';

jest.mock('scrapybara/tools', () => ({ tool: (definition: unknown) => definition }));
jest.mock('@/lib/tools/instance-log-core', () => ({ createInstanceLogCore: jest.fn() }));
jest.mock('@/lib/services/video/VideoGenerationService', () => ({ VideoGenerationService: { generateVideo: jest.fn() } }));
jest.mock('@/lib/services/image/ImageGenerationService', () => ({ ImageGenerationService: { generateImage: jest.fn() } }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
// Billing is deliberately absent: tools must not import or charge CreditService.
jest.mock('@/lib/services/billing/CreditService', () => { throw new Error('Tool must not own billing'); });

beforeEach(() => jest.clearAllMocks());

it.each(['assistant', 'scrapybara'])('rejects unsupported providers independently in both media tools: %s', async mode => {
  const image: any = mode === 'assistant' ? generateImageTool('site') : generateImageToolScrapybara({} as any, 'site');
  const video: any = mode === 'assistant' ? generateVideoTool('site') : generateVideoToolScrapybara({} as any, 'site');
  for (const provider of ['openrouter', 'gemini', 'vercel']) {
    await expect(image.execute({ prompt: 'cat', provider, model: 'raw-deployment' })).rejects.toThrow('Unsupported image provider');
  }
  for (const provider of ['azure', 'gemini', 'vercel']) {
    await expect(video.execute({ prompt: 'cat', provider, model: 'raw-deployment' })).rejects.toThrow('Unsupported video provider');
  }
  expect(ImageGenerationService.generateImage).not.toHaveBeenCalled();
  expect(VideoGenerationService.generateVideo).not.toHaveBeenCalled();
});

it.each(['assistant', 'scrapybara'])('preserves pending video jobs without claiming completion: %s', async mode => {
  const jobId = randomUUID();
  jest.mocked(VideoGenerationService.generateVideo).mockResolvedValueOnce({ success: true, provider: 'openrouter', status: 'pending', job_id: jobId, videos: [] });
  const tool: any = mode === 'assistant' ? generateVideoTool('site') : generateVideoToolScrapybara({} as any, 'site');
  const result = await tool.execute({ prompt: 'cat', job_id: jobId });
  expect(result).toMatchObject({ status: 'pending', job_id: jobId, videos: [] });
  expect(result.message).toContain('poll');
  expect(result.message).not.toContain('Successfully generated');
  expect(VideoGenerationService.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openrouter', site_id: 'site', job_id: jobId }));
});

it.each(['assistant', 'scrapybara'])('defaults image tools to Azure and forwards deployment, size, quality and references: %s', async mode => {
  jest.mocked(ImageGenerationService.generateImage).mockResolvedValueOnce({ success: true, provider: 'azure', images: [{ url: 'https://storage.example.test/a.png' }] });
  const tool: any = mode === 'assistant' ? generateImageTool('site') : generateImageToolScrapybara({} as any, 'site');
  const args = { prompt: 'cat', model: 'image-deployment', size: '1536x1024', quality: 'xhigh', reference_images: ['https://storage.example.test/reference.png'] };
  const result = await tool.execute(args);
  expect(ImageGenerationService.generateImage).toHaveBeenCalledWith(expect.objectContaining({ ...args, provider: 'azure', site_id: 'site' }));
  expect(result).toMatchObject({ success: true, provider: 'azure', images: [{ url: 'https://storage.example.test/a.png' }] });
  expect(result).not.toHaveProperty('fallbackFrom');
  expect(ImageGenerationService.generateImage).toHaveBeenCalledTimes(1);
});

it('advertises only Azure images and deployment overrides without deprecated tiny sizes', () => {
  const definition = generateImageTool('site');
  const properties = definition.parameters.properties;
  expect(properties.provider.enum).toEqual(['azure']);
  expect(properties.model.description).toContain('AZURE_OPENAI_IMAGE_DEPLOYMENT');
  expect(properties.size.description).toContain('auto');
  expect(properties.size.description).toContain('1536x1024');
  expect(properties.size.description).toContain('1024x1536');
  expect(properties.size.description).toContain('custom WIDTHxHEIGHT');
  expect(JSON.stringify(definition.parameters)).not.toMatch(/256x256|512x512|openrouter/i);
  expect(properties.quality).toMatchObject({ type: 'string', enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'standard', 'hd'] });
});

it('retains assistant image instance ownership and returns only stored URLs, never base64', async () => {
  const insert = jest.fn().mockResolvedValue({ error: null });
  jest.mocked(supabaseAdmin.from).mockReturnValue({ insert } as any);
  const url = 'https://storage.example.test/image.png';
  jest.mocked(ImageGenerationService.generateImage).mockResolvedValueOnce({ success: true, provider: 'azure', images: [{ url, b64_json: Buffer.from('synthetic-image').toString('base64') }] });
  const result = await generateImageTool('site', 'instance').execute({ prompt: 'cat', provider: 'azure' });
  expect(ImageGenerationService.generateImage).toHaveBeenCalledWith(expect.objectContaining({ site_id: 'site', instance_id: 'instance', provider: 'azure' }));
  expect(supabaseAdmin.from).toHaveBeenCalledWith('instance_assets');
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ instance_id: 'instance', asset_url: url, asset_type: 'image' }));
  expect(createInstanceLogCore).toHaveBeenCalledWith(expect.objectContaining({ site_id: 'site', instance_id: 'instance' }));
  expect(result.images).toEqual([{ url }]);
  expect(JSON.stringify(result)).not.toContain('b64_json');
});

it.each(['auto', '1024x1024', '1536x1024', '1024x1536', '2048x1024'])('accepts Azure size %s in the Scrapybara schema', size => {
  const definition: any = generateImageToolScrapybara({} as any, 'site');
  expect(definition.parameters.parse({ prompt: 'cat', provider: 'azure', model: 'deployment', size, quality: 'high' })).toMatchObject({ provider: 'azure', size, quality: 'high' });
  expect(definition.parameters.safeParse({ prompt: 'cat', provider: 'openrouter' }).success).toBe(false);
});

it('does not advertise or accept numeric quality in the image tool schema', () => {
  const definition: any = generateImageToolScrapybara({} as any, 'site');
  expect(definition.parameters.safeParse({ prompt: 'cat', quality: 90 }).success).toBe(false);
  expect(generateImageTool('site').parameters.properties.quality.type).toBe('string');
});

it.each(['assistant', 'scrapybara'])('does not retry or fall back when Azure image generation fails: %s', async mode => {
  jest.mocked(ImageGenerationService.generateImage).mockResolvedValueOnce({ success: false, provider: 'azure', images: [], error: 'Quota exceeded' });
  const tool: any = mode === 'assistant' ? generateImageTool('site') : generateImageToolScrapybara({} as any, 'site');
  await expect(tool.execute({ prompt: 'cat' })).rejects.toThrow('No alternate provider was called');
  expect(ImageGenerationService.generateImage).toHaveBeenCalledTimes(1);
  expect(VideoGenerationService.generateVideo).not.toHaveBeenCalled();
});