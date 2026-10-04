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

it('requires explicit operator video model configuration even with a request override', async () => {
  await expect(prepareOpenRouterVideo({ ...body, model: model.id })).rejects.toMatchObject({ status: 503 });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('does not silently substitute Sora 2 Pro for unavailable base Sora 2', async () => {
  process.env.OPENROUTER_VIDEO_MODEL = 'openai/sora-2';
  fetchMock.mockResolvedValueOnce(json({ data: [model] }));
  await expect(prepareOpenRouterVideo(body)).rejects.toMatchObject({ status: 400 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('passes first and last frames unchanged when an arbitrary qualified model advertises support', async () => {
  process.env.OPENROUTER_VIDEO_MODEL = 'vendor.example/frame-model';
  fetchMock.mockResolvedValueOnce(json({ data: [{ ...model, id: process.env.OPENROUTER_VIDEO_MODEL, supported_frame_images: ['first_frame', 'last_frame'] }] }));
  const first = 'https://images.example.test/start.png';
  const last = 'https://images.example.test/end.png';
  const prepared = await prepareOpenRouterVideo({ ...body, duration_seconds: 4, first_frame_url: first, last_frame_url: last });
  expect(prepared).toMatchObject({
    model: 'vendor.example/frame-model', duration: 4,
    frame_images: [
      { image_url: { url: first }, frame_type: 'first_frame' },
      { image_url: { url: last }, frame_type: 'last_frame' },
    ],
  });
});

it.each([
  { duration_seconds: 6 }, { aspect_ratio: '1:1' }, { resolution: '4K' },
  { quality: 'pro' }, { reference_images: ['https://example.test/ref.png'] },
  { first_frame_url: 'https://example.test/start.png' },
])('rejects unsupported capabilities without submitting: %j', async extra => {
  process.env.OPENROUTER_VIDEO_MODEL = model.id;
  fetchMock.mockResolvedValueOnce(json({ data: [model] }));
  await expect(prepareOpenRouterVideo({ ...body, ...extra } as any)).rejects.toMatchObject({ status: 400 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('uses async submit/poll/content endpoints and never follows provider URLs with a bearer', async () => {
  process.env.OPENROUTER_VIDEO_MODEL = 'example/frame-model';
  fetchMock.mockResolvedValueOnce(json({ data: [{ ...model, id: 'example/frame-model', supported_frame_images: ['first_frame'] }] }))
    .mockResolvedValueOnce(json({ id: 'job-123', status: 'pending', polling_url: 'https://attacker.example.test/poll' }, 202))
    .mockResolvedValueOnce(json({ id: 'job-123', status: 'completed', generation_id: 'gen-1', usage: { cost: 0.3 }, unsigned_urls: ['https://attacker.example.test/content'] }))
    .mockResolvedValueOnce(new Response('video', { headers: { 'content-type': 'video/mp4' } }));
  const prepared = await prepareOpenRouterVideo({ ...body, first_frame_url: 'https://images.example.test/first.png', resolution: '720p' });
  expect(prepared).toMatchObject({
    duration: 4, model: 'example/frame-model', resolution: '720p',
    frame_images: [{ type: 'image_url', image_url: { url: 'https://images.example.test/first.png' }, frame_type: 'first_frame' }],
  });
  const job = await submitOpenRouterVideo(prepared);
  expect(await pollOpenRouterVideo(job.id)).toMatchObject({ status: 'completed', usage: { cost: 0.3 } });
  expect((await downloadOpenRouterVideo(job.id)).buffer.toString()).toBe('video');
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
    'https://openrouter.ai/api/v1/videos/models', 'https://openrouter.ai/api/v1/videos',
    'https://openrouter.ai/api/v1/videos/job-123', 'https://openrouter.ai/api/v1/videos/job-123/content?index=0',
  ]);
  for (const [, request] of fetchMock.mock.calls) {
    expect(request.redirect).toBe('error');
    expect(request.headers.Authorization).toBe(`Bearer ${process.env.OPENROUTER_API_KEY}`);
    expect(request.signal).toBeDefined();
  }
});

it('does not retry ambiguous submit failures or expose provider body secrets', async () => {
  const secret = randomBytes(32).toString('hex');
  fetchMock.mockResolvedValueOnce(json({ error: `${secret} ${process.env.OPENROUTER_API_KEY}` }, 500));
  let message = '';
  try { await submitOpenRouterVideo({ model: model.id, prompt: 'cat', duration: 4, aspect_ratio: '16:9' }); }
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