import { randomBytes, randomUUID } from 'node:crypto';
import { ImageGenerationService } from '../ImageGenerationService';
import { VideoGenerationService } from '../../video/VideoGenerationService';

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
let fetchMock: jest.Mock;
beforeEach(() => {
  process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
  process.env.NEXT_PUBLIC_API_SERVER_URL = 'https://api.example.test';
  fetchMock = jest.fn(); global.fetch = fetchMock;
});
afterAll(() => { global.fetch = originalFetch; process.env = originalEnv; });

it.each(['azure', 'gemini', 'vercel'])('rejects direct provider %s without requests, including video polling', async provider => {
  const params = { prompt: 'cat', site_id: 'site', provider, model: 'raw-deployment' } as any;
  expect(await VideoGenerationService.generateVideo({ ...params, job_id: randomUUID() })).toMatchObject({ success: false, error: 'Unsupported video provider' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['openrouter', 'gemini', 'vercel'])('rejects non-Azure image provider %s without requests or aliases', async provider => {
  expect(await ImageGenerationService.generateImage({ prompt: 'cat', site_id: 'site', provider: provider as any })).toMatchObject({ success: false, provider: 'azure', images: [], error: 'Unsupported image provider' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('defaults images to Azure without injecting conflicting square size', async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'azure', images: [{ url: 'https://storage.example.test/image.png' }], metadata: { model: 'image-deployment' } })));
  const result = await ImageGenerationService.generateImage({ prompt: 'cat', site_id: 'site', aspect_ratio: '16:9', model: 'image-deployment' });
  expect(result.success).toBe(true);
  const request = fetchMock.mock.calls[0][1];
  expect(request.headers['x-api-key']).toBe(process.env.SERVICE_API_KEY);
  expect(JSON.parse(request.body)).toEqual({ prompt: 'cat', site_id: 'site', aspect_ratio: '16:9', model: 'image-deployment', provider: 'azure' });
});

it('forwards Azure deployment, custom size, quality labels, references and instance ownership unchanged', async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'azure', images: [{ url: 'https://storage.example.test/image.png' }], metadata: { model: 'custom-deployment', cost: 0.03 } })));
  const params = { prompt: 'cat', site_id: 'site', instance_id: 'instance', provider: 'azure', model: 'custom-deployment', size: '2048x1024', quality: 'high', reference_images: ['https://storage.example.test/reference.png'] } as const;
  const result = await ImageGenerationService.generateImage({ ...params, reference_images: [...params.reference_images] });
  expect(result).toMatchObject({ success: true, provider: 'azure', metadata: { model: 'custom-deployment', cost: 0.03, quality: 'high', size: '2048x1024', n: 1 } });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(params);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('fails closed if the local image API reports an alternate provider', async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'openrouter', images: [{ url: 'https://storage.example.test/image.png' }] })));
  expect(await ImageGenerationService.generateImage({ prompt: 'cat', site_id: 'site' })).toMatchObject({ success: false, provider: 'azure', images: [], error: 'Image API returned an unsupported provider' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('does not retry uncertain Azure transport failures or expose exception details', async () => {
  const secret = randomBytes(32).toString('hex');
  fetchMock.mockRejectedValueOnce(new Error(secret));
  const result = await ImageGenerationService.generateImage({ prompt: 'cat', site_id: 'site', provider: 'azure' });
  expect(result).toMatchObject({ success: false, provider: 'azure', images: [] });
  expect(result.error).toContain('generation outcome may be uncertain');
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('fails without a second request when Azure returns no images', async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'azure', images: [] })));
  expect(await ImageGenerationService.generateImage({ prompt: 'cat', site_id: 'site' })).toMatchObject({ success: false, provider: 'azure', images: [], error: 'Image API returned no images' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('does not retry or use Gemini when either media API fails and does not expose response bodies', async () => {
  const secret = randomBytes(32).toString('hex');
  fetchMock.mockResolvedValueOnce(new Response(secret, { status: 502 }))
    .mockResolvedValueOnce(new Response(secret, { status: 502 }));
  const image = await ImageGenerationService.generateImage({ prompt: 'cat', site_id: 'site' });
  const video = await VideoGenerationService.generateVideo({ prompt: 'cat', site_id: 'site' });
  expect(image.success).toBe(false); expect(video.success).toBe(false);
  expect(JSON.stringify({ image, video })).not.toContain(secret);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).provider).toBe('azure');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).provider).toBe('openrouter');
});

it('retains pending video job ids and polls via GET instead of submitting again', async () => {
  const jobId = randomUUID();
  const payload = { provider: 'openrouter', status: 'pending', job_id: jobId, videos: [], metadata: { model: 'example/video' } };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 202 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...payload, status: 'in_progress' }), { status: 202 }));
  const pending = await VideoGenerationService.generateVideo({ prompt: 'cat', site_id: 'site' });
  expect(pending).toMatchObject({ success: true, status: 'pending', job_id: jobId, videos: [] });
  await VideoGenerationService.generateVideo({ prompt: '', site_id: 'site', job_id: jobId });
  expect(fetchMock.mock.calls[1][1].method).toBe('GET');
  expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
  expect(fetchMock.mock.calls[1][0].searchParams.get('job_id')).toBe(jobId);
});