import { randomBytes } from 'node:crypto';
import { prepareGeminiVideo, submitGeminiVideo, pollGeminiVideo, downloadGeminiVideo } from '../provider-gemini';
import { withExecutionRouting } from '@/lib/services/ai/customer-routing';

// Installed SDK 1.25 lacks the supported Omni Interactions API. Exercise its
// documented REST equivalent with mocked fetch and DNS; no paid generation.
jest.mock('node:dns/promises', () => ({ lookup: jest.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }));
jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: jest.fn(async () => ({})) }));
import { downloadPinnedImage } from '@/lib/security/pinned-image-download';
jest.mock('@/lib/security/pinned-image-download', () => ({ downloadPinnedImage: jest.fn() }));

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
let fetchMock: jest.Mock;
const body = { prompt: 'A cat moves', site_id: 'site' };
const model = 'gemini-omni-1.2-flash';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  process.env = { ...originalEnv, GEMINI_API_KEY: randomBytes(32).toString('hex'), GEMINI_VIDEO_MODEL: model };
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  fetchMock = jest.fn().mockRejectedValue(new Error('Unexpected offline network request'));
  global.fetch = fetchMock;
  jest.mocked(downloadPinnedImage).mockReset();
  jest.mocked(downloadPinnedImage).mockResolvedValue({ buffer: Buffer.from('image'), mimeType: 'image/png' });
});
afterAll(() => { global.fetch = originalFetch; process.env = originalEnv; });

it('requires a key, supports its alias and defaults to supported Omni instead of retired preview', async () => {
  delete process.env.GEMINI_API_KEY;
  await expect(prepareGeminiVideo(body)).rejects.toMatchObject({ status: 503 });
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = randomBytes(32).toString('hex');
  expect(await prepareGeminiVideo(body)).toMatchObject({ model, duration: 8, resolution: '720p' });
  delete process.env.GEMINI_VIDEO_MODEL;
  expect(await prepareGeminiVideo(body)).toMatchObject({ model: 'gemini-omni-1.2-flash' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('maps pinned image failures to safe errors without credentials', async () => {
  const authenticated = new URL('https://images.example.test/ref.png');
  authenticated.username = randomBytes(16).toString('hex');
  authenticated.password = randomBytes(16).toString('hex');
  jest.mocked(downloadPinnedImage).mockRejectedValueOnce(new Error(authenticated.toString()));
  const error = await prepareGeminiVideo({ ...body, first_frame_url: authenticated.toString() }).catch(error => error);
  expect(error).toMatchObject({ status: 400 });
  expect(String(error)).not.toContain(authenticated.username);
  expect(String(error)).not.toContain(authenticated.password);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('prohibits platform Gemini dispatch in customer execution scope', async () => {
  const routing = { payer: 'customer' as const, siteId: 'site', connectionId: 'connection', policyVersion: 1, credentialVersion: 1 };
  // Host context helper revalidates customer storage; mock only this boundary.
  await expect(withExecutionRouting(routing, 'site', () => prepareGeminiVideo(body))).rejects.toMatchObject({ code: 'CUSTOMER_ADAPTER_UNSUPPORTED_VIDEO' });
  expect(fetchMock).not.toHaveBeenCalled();
});

describe('supported Omni Interactions REST (SDK 1.25 lacks this API)', () => {
  const omniId = 'interactions/interaction-123';
  const video = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);
  const completed = { id: 'interaction-123', status: 'completed', steps: [{ type: 'user_input', content: [{ type: 'text', text: 'input' }] }, { type: 'model_output', content: [{ type: 'video', data: video.toString('base64'), mime_type: 'video/mp4' }] }] };
  beforeEach(() => { delete process.env.GEMINI_VIDEO_MODEL; });

  it('submits once in background, polls without resubmit and decodes bounded MP4', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'interaction-123', status: 'in_progress' }))
      .mockResolvedValueOnce(json(completed)).mockResolvedValueOnce(json(completed));
    const prepared = await prepareGeminiVideo(body);
    expect(await submitGeminiVideo(prepared)).toEqual({ id: omniId, status: 'in_progress' });
    expect(await pollGeminiVideo(omniId)).toEqual({ id: omniId, status: 'completed' });
    expect(await downloadGeminiVideo(omniId)).toEqual({ buffer: video, mimeType: 'video/mp4' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'gemini-omni-1.2-flash', background: true, store: true, stream: false,
      response_format: { type: 'video', duration: '8s', aspect_ratio: '16:9', resolution: '720p' },
    });
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      `https://generativelanguage.googleapis.com/v1beta/${omniId}`,
      `https://generativelanguage.googleapis.com/v1beta/${omniId}`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.redirect).toBe('error'); expect(init.headers['x-goog-api-key']).toBe(process.env.GEMINI_API_KEY);
      expect(init.signal).toBeDefined();
    }
  });

  it.each([3, 4, 6, 8, 15])('accepts documented %s second Omni video', async duration => {
    expect(await prepareGeminiVideo({ ...body, duration_seconds: duration, resolution: '1080p' })).toMatchObject({ duration });
  });

  it.each([{ duration_seconds: 40 }, { duration_seconds: 2 }, { duration_seconds: 4.5 },
    { model: 'veo-3.1-generate-preview' }, { aspect_ratio: '1:1' as const }, { resolution: '4K' }, { quality: 'pro' as const },
    { reference_images: Array(7).fill('https://images.example.test/ref.png') },
    { first_frame_url: 'https://images.example.test/first.png', last_frame_url: 'https://images.example.test/last.png', duration_seconds: 11 },
    { reference_images: ['https://images.example.test/ref.png'], first_frame_url: 'https://images.example.test/first.png' },
  ])('rejects invalid Omni mode without network: %j', async extra => {
    await expect(prepareGeminiVideo({ ...body, ...extra })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes refs as inline bytes with explicit reference task, never provider URLs', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'interaction-123', status: 'in_progress' }));
    const prepared = await prepareGeminiVideo({ ...body, reference_images: ['https://images.example.test/ref.png'], duration_seconds: 4, aspect_ratio: '9:16' });
    await submitGeminiVideo(prepared);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      input: [{ type: 'image', data: Buffer.from('image').toString('base64'), mime_type: 'image/png' }, { type: 'text', text: body.prompt }],
      generation_config: { video_config: { task: 'reference_to_video' } },
    });
    expect(downloadPinnedImage).toHaveBeenCalledWith('https://images.example.test/ref.png');
  });

  it('preserves first then last frame ordering exactly as documented interpolation input', async () => {
    jest.mocked(downloadPinnedImage).mockResolvedValueOnce({ buffer: Buffer.from('first'), mimeType: 'image/png' })
      .mockResolvedValueOnce({ buffer: Buffer.from('last'), mimeType: 'image/jpeg' });
    fetchMock.mockResolvedValueOnce(json({ id: 'interaction-123', status: 'in_progress' }));
    const prepared = await prepareGeminiVideo({ ...body, first_frame_url: 'https://images.example.test/first.png', last_frame_url: 'https://images.example.test/last.jpg' });
    await submitGeminiVideo(prepared);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.input).toEqual([
      { type: 'image', data: Buffer.from('first').toString('base64'), mime_type: 'image/png' },
      { type: 'image', data: Buffer.from('last').toString('base64'), mime_type: 'image/jpeg' },
      { type: 'text', text: body.prompt },
    ]);
    expect(payload.generation_config).toBeUndefined();
  });

  it.each([400, 401, 402, 403, 404, 422, 429, 500])('preserves HTTP %s status without raw response detail', async status => {
    const secret = randomBytes(32).toString('hex');
    fetchMock.mockResolvedValueOnce(json({ error: `${secret} ${process.env.GEMINI_API_KEY}` }, status));
    const error = await submitGeminiVideo(await prepareGeminiVideo(body)).catch(error => error);
    expect(error).toMatchObject({ status, message: `Gemini video request failed (${status})` });
    expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(process.env.GEMINI_API_KEY!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles immediate REST completion on submit without SDK convenience fields', async () => {
    fetchMock.mockResolvedValueOnce(json(completed));
    expect(await submitGeminiVideo(await prepareGeminiVideo(body))).toEqual({ id: omniId, status: 'completed' });
  });

  it('ignores video-shaped user input and SDK-only output_video', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'interaction-123', status: 'completed',
      output_video: { data: video.toString('base64') },
      steps: [{ type: 'user_input', content: [{ type: 'video', data: video.toString('base64') }] }] }));
    expect(await pollGeminiVideo(omniId)).toEqual({ id: omniId, status: 'failed' });
  });

  it('validates interaction identity/status and does not follow arbitrary output URLs', async () => {
    await expect(pollGeminiVideo('interactions/../evil')).rejects.toThrow('Invalid');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ ...completed, id: 'different' }));
    await expect(pollGeminiVideo(omniId)).rejects.toThrow('mismatched');
    fetchMock.mockResolvedValueOnce(json({ id: 'interaction-123', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'https://attacker.example.test/video' }] }] }));
    expect(await pollGeminiVideo(omniId)).toEqual({ id: omniId, status: 'failed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['not base64', Buffer.from('not mp4').toString('base64')])('rejects invalid base64/MP4 output: %s', async data => {
    fetchMock.mockResolvedValueOnce(json({ ...completed, steps: [{ type: 'model_output', content: [{ type: 'video', data }] }] }));
    await expect(downloadGeminiVideo(omniId)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects oversized responses before JSON decode and strips secrets on ambiguous submit', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': String(141 * 1024 * 1024) } }));
    await expect(downloadGeminiVideo(omniId)).rejects.toMatchObject({ status: 502 });
    const secret = randomBytes(32).toString('hex');
    fetchMock.mockResolvedValueOnce(json({ error: `${secret} ${process.env.GEMINI_API_KEY}` }, 500));
    const error = await submitGeminiVideo(await prepareGeminiVideo(body)).catch(error => error);
    expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(process.env.GEMINI_API_KEY!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});