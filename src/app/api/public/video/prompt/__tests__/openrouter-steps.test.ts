import { randomUUID } from 'node:crypto';
import { generateAndCacheVideoStep } from '../steps';
import { VideoGenerationService } from '@/lib/services/video/VideoGenerationService';
import { generateAndCacheImageStep } from '../../../image/prompt/steps';
import { ImageGenerationService } from '@/lib/services/image/ImageGenerationService';
import { setCachedJson } from '@/lib/security/upstash-rest';

const mockStore = new Map<string, unknown>();
jest.mock('workflow', () => ({ sleep: jest.fn(async () => {}),
  getStepMetadata: jest.fn(() => ({ stepId: 'step_offline_video_image' })),
}));
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
  expect(VideoGenerationService.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ site_id: 'site' }));
  expect(jest.mocked(VideoGenerationService.generateVideo).mock.calls[0][0]).not.toHaveProperty('provider');
  expect(VideoGenerationService.getVideoJob).toHaveBeenCalledWith('site', jobId);
});

it('public image uses Azure without the legacy square-size/ratio conflict', async () => {
  jest.mocked(ImageGenerationService.generateImage).mockResolvedValueOnce({ success: false, provider: 'azure', images: [], error: 'not generated' });
  await expect(generateAndCacheImageStep('cat', 'site', '1024x1024', '16:9', 'hash')).rejects.toThrow('not generated');
  expect(ImageGenerationService.generateImage).toHaveBeenCalledWith(
    { prompt: 'cat', site_id: 'site', size: undefined, ratio: '16:9', provider: 'azure' },
    { operationId: 'workflow-image:step_offline_video_image' },
  );
});

it('replaces a confirmed rejected Gemini job on the next request and polls its replacement', async () => {
  const rejectedId = randomUUID(), nextId = randomUUID();
  const rejected = { success: false, provider: 'gemini' as const, status: 'failed' as const,
    submission_rejected: true, job_id: rejectedId, videos: [] };
  const pending = { success: true, provider: 'gemini' as const, status: 'pending' as const, job_id: nextId, videos: [] };
  jest.mocked(VideoGenerationService.generateVideo).mockResolvedValueOnce(rejected).mockResolvedValueOnce(pending);
  jest.mocked(VideoGenerationService.getVideoJob).mockResolvedValueOnce(rejected).mockResolvedValueOnce(pending);
  await generateAndCacheVideoStep('cat', 'site', 8, '16:9', 'hash');
  expect(VideoGenerationService.generateVideo).toHaveBeenCalledTimes(1);
  expect(await generateAndCacheVideoStep('cat', 'site', 8, '16:9', 'hash')).toMatchObject({ status: 'pending', job_id: nextId });
  expect(mockStore.get('ai-video:public:site:hash')).toBe(nextId);
  await generateAndCacheVideoStep('cat', 'site', 8, '16:9', 'hash');
  expect(VideoGenerationService.generateVideo).toHaveBeenCalledTimes(2);
  expect(VideoGenerationService.getVideoJob).toHaveBeenLastCalledWith('site', nextId);
});

it.each(['pending', 'in_progress', 'failed'] as const)('never infers permission to resubmit from %s or error text', async status => {
  const job_id = randomUUID();
  mockStore.set('ai-video:public:site:hash', job_id);
  jest.mocked(VideoGenerationService.getVideoJob).mockResolvedValueOnce({ success: false, provider: 'gemini', status,
    job_id, videos: [], error: 'Gemini rejected the video request or configuration' });
  await generateAndCacheVideoStep('cat', 'site', 8, '16:9', 'hash');
  expect(VideoGenerationService.generateVideo).not.toHaveBeenCalled();
});

it('retains uncertain retry intent if the replacement submit response is lost', async () => {
  const job_id = randomUUID();
  mockStore.set('ai-video:public:site:hash', job_id);
  jest.mocked(VideoGenerationService.getVideoJob).mockResolvedValueOnce({ success: false, provider: 'gemini', status: 'failed',
    submission_rejected: true, job_id, videos: [] });
  jest.mocked(VideoGenerationService.generateVideo).mockResolvedValueOnce({ success: false, provider: 'gemini', videos: [], error: 'timeout' });
  await generateAndCacheVideoStep('cat', 'site', 8, '16:9', 'hash');
  expect(await generateAndCacheVideoStep('cat', 'site', 8, '16:9', 'hash')).toMatchObject({ status: 'pending' });
  expect(VideoGenerationService.generateVideo).toHaveBeenCalledTimes(1);
  expect(VideoGenerationService.getVideoJob).toHaveBeenCalledTimes(1);
});

it('does not replace a rejected platform job using customer BYOK routing', async () => {
  const job_id = randomUUID();
  mockStore.set('ai-video:public:site:hash', job_id);
  jest.mocked(VideoGenerationService.getVideoJob).mockResolvedValueOnce({ success: false, provider: 'gemini', status: 'failed',
    submission_rejected: true, job_id, videos: [] });
  await generateAndCacheVideoStep('cat', 'site', 8, '16:9', 'hash', {
    payer: 'customer', siteId: 'site', connectionId: randomUUID(), credentialVersion: 1, policyVersion: 1,
  });
  expect(VideoGenerationService.generateVideo).not.toHaveBeenCalled();
});

it('does not resubmit if retry intent cannot be persisted', async () => {
  const job_id = randomUUID();
  mockStore.set('ai-video:public:site:hash', job_id);
  jest.mocked(VideoGenerationService.getVideoJob).mockResolvedValueOnce({ success: false, provider: 'gemini', status: 'failed',
    submission_rejected: true, job_id, videos: [] });
  jest.mocked(setCachedJson).mockResolvedValueOnce(false);
  expect(await generateAndCacheVideoStep('cat', 'site', 8, '16:9', 'hash')).toMatchObject({ status: 'failed', job_id });
  expect(VideoGenerationService.generateVideo).not.toHaveBeenCalled();
});