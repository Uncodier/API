jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn().mockResolvedValue(undefined) }));
import { createHash, randomBytes } from 'node:crypto';
import { startVideoJob, resumeVideoJob } from '../openrouter-jobs';
import { submitGeminiVideo, pollGeminiVideo, downloadGeminiVideo } from '../provider-gemini';
import { pollOpenRouterVideo, downloadOpenRouterVideo } from '../provider-openrouter';
import { persistGeneratedVideo } from '../video-storage';
import { CreditService } from '@/lib/services/billing/CreditService';
import { setCachedJson } from '@/lib/security/upstash-rest';
import { MediaRequestError } from '@/lib/services/image/media-request-error';

const mockStore = new Map<string, unknown>();
jest.mock('@/lib/security/upstash-rest', () => ({
  sha256: jest.fn(async (value: string) => createHash('sha256').update(value).digest('hex')),
  getCachedJson: jest.fn(async (key: string) => mockStore.has(key) ? JSON.parse(JSON.stringify(mockStore.get(key))) : null),
  setCachedJson: jest.fn(async (key: string, value: unknown) => { mockStore.set(key, JSON.parse(JSON.stringify(value))); return true; }),
}));
jest.mock('../provider-gemini', () => ({
  submitGeminiVideo: jest.fn(), pollGeminiVideo: jest.fn(), downloadGeminiVideo: jest.fn(),
}));
jest.mock('../provider-openrouter', () => ({ pollOpenRouterVideo: jest.fn(), downloadOpenRouterVideo: jest.fn() }));
jest.mock('../video-storage', () => ({ persistGeneratedVideo: jest.fn() }));
jest.mock('@/lib/services/billing/CreditService', () => ({
  CreditService: { PRICING: { VIDEO_GENERATION_MINUTE: 24 }, deductCredits: jest.fn() },
}));

const body = { prompt: 'cat', site_id: 'site-a', instance_id: 'instance-a' };
const prepared = { model: 'example/video', prompt: body.prompt, duration: 8, aspect_ratio: '16:9', geminiConfig: {} };
beforeEach(() => {
  jest.clearAllMocks(); mockStore.clear();
  jest.mocked(submitGeminiVideo).mockResolvedValue({ id: 'upstream-1', status: 'pending' });
  jest.mocked(pollGeminiVideo).mockResolvedValue({ id: 'upstream-1', status: 'completed', generation_id: 'gen-1', usage: { cost: 0.4 } });
  jest.mocked(downloadGeminiVideo).mockResolvedValue({ buffer: Buffer.from('video'), mimeType: 'video/mp4' });
  jest.mocked(persistGeneratedVideo).mockResolvedValue({ url: 'https://storage.example.test/video.mp4', mimeType: 'video/mp4' });
  jest.mocked(CreditService.deductCredits).mockResolvedValue({ success: true });
});

it('retains site ownership and job id before submit, then persists and bills once on completion', async () => {
  jest.mocked(submitGeminiVideo).mockImplementationOnce(async () => {
    expect(mockStore.size).toBe(2);
    expect(Array.from(mockStore.values()).some((value: any) => value.siteId === body.site_id)).toBe(true);
    return { id: 'upstream-1', status: 'pending' };
  });
  const accepted = await startVideoJob(body, prepared);
  expect(accepted).toMatchObject({ provider: 'gemini', status: 'pending', videos: [] });
  expect(accepted.job_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
  expect(await startVideoJob(body, prepared)).toEqual(accepted);
  expect(submitGeminiVideo).toHaveBeenCalledTimes(1);
  const completed = await resumeVideoJob(body.site_id, accepted.job_id!);
  expect(completed).toMatchObject({ status: 'completed', job_id: accepted.job_id, metadata: { cost: 0.4, generation_id: 'gen-1' } });
  expect(completed.videos).toHaveLength(1);
  expect(persistGeneratedVideo).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'gemini', siteId: 'site-a', instanceId: 'instance-a', model: prepared.model,
  }));
  expect(CreditService.deductCredits).toHaveBeenCalledWith('site-a', 3.2, 'video_generation', expect.any(String), expect.objectContaining({ job_id: accepted.job_id }));
  expect(await resumeVideoJob(body.site_id, accepted.job_id!)).toEqual(completed);
  expect(await startVideoJob(body, prepared)).toEqual(completed);
  expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
  expect(persistGeneratedVideo).toHaveBeenCalledTimes(1);
  expect(submitGeminiVideo).toHaveBeenCalledTimes(1);
});

it('blocks cross-site polling before contacting upstream or charging', async () => {
  const accepted = await startVideoJob(body, prepared);
  await expect(resumeVideoJob('site-b', accepted.job_id!)).rejects.toMatchObject({ status: 404 });
  expect(pollGeminiVideo).not.toHaveBeenCalled();
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
});

it('rejects a new platform OpenRouter job before persistence or submission', async () => {
  await expect(startVideoJob({ ...body, provider: 'openrouter' }, prepared)).rejects.toMatchObject({ status: 400 });
  expect(mockStore.size).toBe(0);
  expect(submitGeminiVideo).not.toHaveBeenCalled();
});

it('resumes a legacy untagged OpenRouter job without submitting to either provider', async () => {
  const id = 'legacy-job';
  mockStore.set(`ai-video:job:${id}`, { id, siteId: body.site_id, instanceId: body.instance_id,
    fingerprint: 'legacy', upstreamId: 'legacy-upstream', request: prepared,
    status: 'pending', createdAt: 'now' });
  jest.mocked(pollOpenRouterVideo).mockResolvedValueOnce({ id: 'legacy-upstream', status: 'completed' });
  jest.mocked(downloadOpenRouterVideo).mockResolvedValueOnce({ buffer: Buffer.from('video'), mimeType: 'video/mp4' });
  expect(await resumeVideoJob(body.site_id, id)).toMatchObject({ provider: 'openrouter', status: 'completed' });
  expect(pollOpenRouterVideo).toHaveBeenCalledWith('legacy-upstream');
  expect(submitGeminiVideo).not.toHaveBeenCalled();
  expect(pollGeminiVideo).not.toHaveBeenCalled();
});

it('does not cache inline image bytes after submitting Gemini references', async () => {
  const imageBytes = randomBytes(64).toString('base64');
  const omniInput = [{ type: 'image' as const, data: imageBytes, mime_type: 'image/png' }];
  await startVideoJob(body, { ...prepared, omniInput });
  expect(JSON.stringify(Array.from(mockStore.values()))).not.toContain(imageBytes);
  expect(submitGeminiVideo).toHaveBeenCalledWith(expect.objectContaining({ omniInput }));
});

it('does not submit when job persistence is unavailable', async () => {
  jest.mocked(setCachedJson).mockResolvedValueOnce(false);
  await expect(startVideoJob(body, prepared)).rejects.toMatchObject({ status: 503 });
  expect(submitGeminiVideo).not.toHaveBeenCalled();
});

it('retains ambiguous submission without exposing secrets or resubmitting', async () => {
  const secret = randomBytes(32).toString('hex');
  jest.mocked(submitGeminiVideo).mockRejectedValueOnce(new Error(secret));
  const accepted = await startVideoJob(body, prepared);
  expect(accepted.job_id).toBeDefined();
  expect(accepted.error).toContain('uncertain');
  expect(JSON.stringify(accepted)).not.toContain(secret);
  expect(await startVideoJob(body, prepared)).toEqual(accepted);
  expect(await resumeVideoJob(body.site_id, accepted.job_id!)).toEqual(accepted);
  expect(submitGeminiVideo).toHaveBeenCalledTimes(1);
  expect(pollGeminiVideo).not.toHaveBeenCalled();
});

it.each([400, 401, 402, 403, 404, 422, 429])('releases admission after explicit HTTP %s rejection and permits same request after correction', async status => {
  jest.mocked(submitGeminiVideo).mockRejectedValueOnce(new MediaRequestError(`Gemini video request failed (${status})`, status));
  const rejected = await startVideoJob(body, prepared);
  expect(rejected).toMatchObject({ status: 'failed', submission_rejected: true, videos: [] });
  expect((await resumeVideoJob(body.site_id, rejected.job_id!)).status).toBe('failed');
  expect(pollGeminiVideo).not.toHaveBeenCalled();
  const retried = await startVideoJob(body, prepared);
  expect(retried.status).toBe('pending');
  expect(retried.job_id).not.toBe(rejected.job_id);
  expect(submitGeminiVideo).toHaveBeenCalledTimes(2);
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
});

it.each([500, 502, 503, 504])('never resubmits after uncertain upstream HTTP %s failure', async status => {
  jest.mocked(submitGeminiVideo).mockRejectedValueOnce(new MediaRequestError(`Gemini video request failed (${status})`, status));
  const uncertain = await startVideoJob(body, prepared);
  expect(uncertain.status).toBe('pending');
  expect(uncertain).not.toHaveProperty('submission_rejected');
  expect(await startVideoJob(body, prepared)).toEqual(uncertain);
  await expect(startVideoJob(body, { ...prepared, prompt: 'different' })).rejects.toMatchObject({ status: 409 });
  expect(submitGeminiVideo).toHaveBeenCalledTimes(1);
});

it('keeps in-progress and failed jobs unbilled', async () => {
  const accepted = await startVideoJob(body, prepared);
  jest.mocked(pollGeminiVideo).mockResolvedValueOnce({ id: 'upstream-1', status: 'in_progress' });
  expect((await resumeVideoJob(body.site_id, accepted.job_id!)).status).toBe('in_progress');
  jest.mocked(pollGeminiVideo).mockResolvedValueOnce({ id: 'upstream-1', status: 'failed' });
  expect((await resumeVideoJob(body.site_id, accepted.job_id!)).status).toBe('failed');
  expect(downloadGeminiVideo).not.toHaveBeenCalled();
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
});

it('never recharges after an ambiguous billing response', async () => {
  const accepted = await startVideoJob(body, prepared);
  jest.mocked(CreditService.deductCredits).mockRejectedValueOnce(new Error('connection lost'));
  await expect(resumeVideoJob(body.site_id, accepted.job_id!)).rejects.toThrow('connection lost');
  const retry = await resumeVideoJob(body.site_id, accepted.job_id!);
  expect(retry.error).toContain('reconciliation');
  expect(retry.videos).toEqual([]);
  expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
});