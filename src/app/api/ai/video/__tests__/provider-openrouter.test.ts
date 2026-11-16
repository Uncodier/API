import { randomBytes } from 'node:crypto';
import { prepareOpenRouterVideo, submitOpenRouterVideo, pollOpenRouterVideo, downloadOpenRouterVideo } from '../provider-openrouter';

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
let fetchMock: jest.Mock;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const model = {
  id: 'openai/sora-2-pro', supported_durations: [4, 8, 12],
  supported_aspect_ratios: ['16:9', '9:16'], supported_resolutions: ['720p', '1080p'],
  supported_frame_images: null,
};
const body = { prompt: 'A cat moves', site_id: 'site' };
beforeEach(() => {
  process.env.OPENROUTER_API_KEY = randomBytes(32).toString('hex');
  delete process.env.OPENROUTER_VIDEO_MODEL;
  fetchMock = jest.fn(); global.fetch = fetchMock;
});
afterAll(() => { global.fetch = originalFetch; process.env = originalEnv; });

it('blocks all new platform OpenRouter generation before any network request', async () => {
  process.env.OPENROUTER_VIDEO_MODEL = model.id;
  await expect(prepareOpenRouterVideo(body)).rejects.toMatchObject({ status: 400 });
  await expect(submitOpenRouterVideo({ model: model.id, prompt: 'cat', duration: 4, aspect_ratio: '16:9' })).rejects.toMatchObject({ status: 400 });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('can resume and download an already accepted legacy platform job', async () => {
  fetchMock.mockResolvedValueOnce(json({ id: 'job-123', status: 'completed' }))
    .mockResolvedValueOnce(new Response('video', { headers: { 'content-type': 'video/mp4' } }));
  expect(await pollOpenRouterVideo('job-123')).toMatchObject({ status: 'completed' });
  expect((await downloadOpenRouterVideo('job-123')).buffer.toString()).toBe('video');
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
    'https://openrouter.ai/api/v1/videos/job-123',
    'https://openrouter.ai/api/v1/videos/job-123/content?index=0',
  ]);
  for (const [, request] of fetchMock.mock.calls) expect(request.redirect).toBe('error');
});

it('does not retry ambiguous submit failures or expose provider body secrets', async () => {
  const secret = randomBytes(32).toString('hex');
  fetchMock.mockResolvedValueOnce(json({ error: `${secret} ${process.env.OPENROUTER_API_KEY}` }, 500));
  let message = '';
  try { await pollOpenRouterVideo('job-123'); }
  catch (error) { message = String(error); }
  expect(message).not.toContain(secret);
  expect(message).not.toContain(process.env.OPENROUTER_API_KEY!);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('rejects mismatched jobs and oversized video downloads', async () => {
  fetchMock.mockResolvedValueOnce(json({ id: 'different', status: 'completed' }));
  await expect(pollOpenRouterVideo('job-123')).rejects.toThrow('mismatched');
  fetchMock.mockResolvedValueOnce(new Response('video', { headers: { 'content-length': String(101 * 1024 * 1024), 'content-type': 'video/mp4' } }));
  await expect(downloadOpenRouterVideo('job-123')).rejects.toThrow('exceeds');
});