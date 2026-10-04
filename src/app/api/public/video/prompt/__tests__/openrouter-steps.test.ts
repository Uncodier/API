import { randomUUID } from 'node:crypto';
import { generateAndCacheVideoStep } from '../steps';
import { VideoGenerationService } from '@/lib/services/video/VideoGenerationService';
import { generateAndCacheImageStep } from '../../../image/prompt/steps';
import { ImageGenerationService } from '@/lib/services/image/ImageGenerationService';

const mockStore = new Map<string, unknown>();
jest.mock('@/lib/security/upstash-rest', () => ({
  getCachedJson: jest.fn(async (key: string) => mockStore.get(key) || null),
  setCachedJson: jest.fn(async (key: string, value: unknown) => { mockStore.set(key, value); return true; }),
}));
jest.mock('@/lib/services/video/VideoGenerationService', () => ({
  VideoGenerationService: { generateVideo: jest.fn(), getVideoJob: jest.fn() },
}));
jest.mock('@/lib/services/image/ImageGenerationService', () => ({ ImageGenerationService: { generateImage: jest.fn() } }));
jest.mock('@/lib/services/video/promptVideoCache', () => ({ uploadVideoToCache: jest.fn() }));
jest.mock('@/lib/services/image/promptImageCache', () => ({ uploadToCache: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));

beforeEach(() => { jest.clearAllMocks(); mockStore.clear(); });

it('public video retains and polls one async job rather than generating again', async () => {
  const jobId = randomUUID();
  jest.mocked(VideoGenerationService.generateVideo).mockResolvedValueOnce({ success: true, provider: 'openrouter', status: 'pending', job_id: jobId, videos: [] });
  jest.mocked(VideoGenerationService.getVideoJob).mockResolvedValueOnce({ success: true, provider: 'openrouter', status: 'in_progress', job_id: jobId, videos: [] });
  expect(await generateAndCacheVideoStep('cat', 'site', 4, '16:9', 'hash')).toEqual({ status: 'pending', job_id: jobId });
  expect(await generateAndCacheVideoStep('cat', 'site', 4, '16:9', 'hash')).toEqual({ status: 'in_progress', job_id: jobId });
  expect(VideoGenerationService.generateVideo).toHaveBeenCalledTimes(1);
  expect(VideoGenerationService.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openrouter', site_id: 'site' }));
  expect(VideoGenerationService.getVideoJob).toHaveBeenCalledWith('site', jobId);
});

it('public image uses Azure without the legacy square-size/ratio conflict', async () => {
  jest.mocked(ImageGenerationService.generateImage).mockResolvedValueOnce({ success: false, provider: 'azure', images: [], error: 'not generated' });
  await expect(generateAndCacheImageStep('cat', 'site', '1024x1024', '16:9', 'hash')).rejects.toThrow('not generated');
  expect(ImageGenerationService.generateImage).toHaveBeenCalledWith({ prompt: 'cat', site_id: 'site', size: undefined, ratio: '16:9', provider: 'azure' });
});