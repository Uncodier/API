import { randomBytes } from 'node:crypto';
import { generateWithAzure } from '../provider-azure';
import { persistGeneratedImage } from '../image-storage';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { getAzureImageConfig } from '@/lib/services/image/azure-image-config';

jest.mock('../image-storage', () => ({
  persistGeneratedImage: jest.fn(async () => ({ url: 'https://storage.example.test/image.png', b64_json: null })),
}));
jest.mock('@/lib/security/safe-remote-url', () => ({
  assertSafeRemoteUrl: jest.fn(async (value: string) => new URL(value)),
}));

const options = { prompt: 'A cat', siteId: 'site', count: 1 };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const output = { data: [{ b64_json: png.toString('base64') }] };
const originalFetch = global.fetch;
const originalEnv = process.env;
let fetchMock: jest.Mock;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    NODE_ENV: 'test',
    MICROSOFT_AZURE_OPENAI_ENDPOINT: 'https://image-test.openai.azure.com',
    MICROSOFT_AZURE_OPENAI_API_KEY: randomBytes(32).toString('hex'),
    MICROSOFT_AZURE_OPENAI_DEPLOYMENT: 'chat-deployment',
    MICROSOFT_AZURE_OPENAI_API_VERSION: '2024-12-01-preview',
    OPENROUTER_API_KEY: randomBytes(32).toString('hex'),
    OPENROUTER_IMAGE_MODEL: 'openai/not-the-azure-deployment',
    OPENROUTER_IMAGE_PROVIDER: 'openai',
  };
  fetchMock = jest.fn(); global.fetch = fetchMock;
});
afterAll(() => { global.fetch = originalFetch; process.env = originalEnv; });

it('uses Azure directly with existing credentials and separate image defaults; persists PNG without inventing cost', async () => {
  fetchMock.mockResolvedValueOnce(json({ ...output, id: 'image-id', usage: { total_tokens: 20, cost: 42 } }));
  const result = await generateWithAzure({ ...options, ratio: '16:9', quality: 'hd', instanceId: 'instance' });
  const [url, request] = fetchMock.mock.calls[0];
  expect(url.toString()).toBe('https://image-test.openai.azure.com/openai/v1/images/generations?api-version=preview');
  expect(request).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
  expect(request.signal).toBeDefined();
  expect(request.headers).toEqual({ 'api-key': process.env.MICROSOFT_AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' });
  expect(JSON.parse(request.body)).toEqual({
    prompt: 'A cat', model: 'gpt-image-2.5-sunburst', n: 1, quality: 'high', size: '1536x864', output_format: 'png',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(persistGeneratedImage).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'azure', model: 'gpt-image-2.5-sunburst', siteId: 'site', instanceId: 'instance',
    base64Data: output.data[0].b64_json, mimeType: 'image/png', generationId: 'image-id',
  }));
  expect(result).toMatchObject({ provider: 'azure', metadata: { model: 'gpt-image-2.5-sunburst', generation_id: 'image-id' } });
  expect(result.metadata).not.toHaveProperty('cost');
});

it('uses dedicated image endpoint/key/deployment and supports an explicit Azure deployment override', async () => {
  Object.assign(process.env, {
    AZURE_OPENAI_IMAGE_ENDPOINT: 'https://dedicated.services.ai.azure.com/openai/v1/',
    AZURE_OPENAI_IMAGE_API_KEY: randomBytes(32).toString('hex'),
    AZURE_OPENAI_IMAGE_DEPLOYMENT: 'image-alias', AZURE_OPENAI_IMAGE_API_VERSION: 'v1',
  });
  fetchMock.mockResolvedValueOnce(json(output));
  await generateWithAzure({ ...options, model: 'chosen-image', size: '1024x1024', quality: 'standard' });
  const [url, request] = fetchMock.mock.calls[0];
  expect(url.toString()).toBe('https://dedicated.services.ai.azure.com/openai/v1/images/generations?api-version=v1');
  expect(request.headers['api-key']).toBe(process.env.AZURE_OPENAI_IMAGE_API_KEY);
  expect(JSON.parse(request.body)).toMatchObject({ model: 'chosen-image', quality: 'medium' });
});

it('accepts conventional Azure endpoint/key names without using a generic chat deployment', () => {
  const key = randomBytes(32).toString('hex');
  expect(getAzureImageConfig({ AZURE_OPENAI_ENDPOINT: 'https://test.openai.azure.com', AZURE_OPENAI_API_KEY: key }))
    .toMatchObject({ deployment: 'gpt-image-2.5-sunburst', apiKey: key });
});

it('supports a dated image API version without inheriting the legacy chat version', async () => {
  process.env.AZURE_OPENAI_IMAGE_API_VERSION = '2025-04-01-preview';
  fetchMock.mockResolvedValueOnce(json(output));
  await generateWithAzure({ ...options, model: 'gpt-image-1' });
  expect(fetchMock.mock.calls[0][0].toString()).toBe('https://image-test.openai.azure.com/openai/deployments/gpt-image-1/images/generations?api-version=2025-04-01-preview');
});

it.each(Object.entries({ '1:1': '1024x1024', '4:3': '1536x1152', '3:4': '1152x1536',
  '16:9': '1536x864', '9:16': '864x1536', '3:2': '1536x1024', '2:3': '1024x1536' }))(
  'converts ratio %s into supported pixel size %s', async (ratio, size) => {
    fetchMock.mockResolvedValueOnce(json(output));
    await generateWithAzure({ ...options, ratio } as any);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).size).toBe(size);
  },
);

it('downloads validated references without credentials and submits multipart Azure edits', async () => {
  fetchMock.mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png' } }))
    .mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/jpeg; charset=binary' } }))
    .mockResolvedValueOnce(json(output));
  const references = ['https://images.example.test/a.png', 'https://images.example.test/b.jpg'];
  await generateWithAzure({ ...options, referenceImages: references });
  expect(assertSafeRemoteUrl).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
  expect(fetchMock.mock.calls[1][1].headers).toBeUndefined();
  const [url, request] = fetchMock.mock.calls[2];
  expect(url.toString()).toBe('https://image-test.openai.azure.com/openai/v1/images/edits?api-version=preview');
  expect(request.headers).toEqual({ 'api-key': process.env.MICROSOFT_AZURE_OPENAI_API_KEY });
  expect(request.body).toBeInstanceOf(FormData);
  expect(request.body.get('model')).toBe('gpt-image-2.5-sunburst');
  expect(request.body.getAll('image[]')).toHaveLength(2);
  expect(request.body.get('output_format')).toBe('png');
});

it('supports multipart edits with the dated deployment endpoint', async () => {
  process.env.AZURE_OPENAI_IMAGE_API_VERSION = '2025-04-01-preview';
  fetchMock.mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png' } }))
    .mockResolvedValueOnce(json(output));
  await generateWithAzure({ ...options, referenceImages: ['https://images.example.test/a.png'] });
  expect(fetchMock.mock.calls[1][0].pathname).toBe('/openai/deployments/gpt-image-2.5-sunburst/images/edits');
});

it('starts all bounded reference downloads before waiting for any, then submits only once', async () => {
  const pending: Array<(response: Response) => void> = [];
  fetchMock.mockImplementation((url: URL) => url.pathname === '/openai/v1/images/edits'
    ? Promise.resolve(json(output))
    : new Promise<Response>(resolve => { pending.push(resolve); }));
  const generation = generateWithAzure({ ...options, referenceImages: [
    'https://images.example.test/a.png', 'https://images.example.test/b.png',
    'https://images.example.test/c.png', 'https://images.example.test/d.png',
  ] });
  await Promise.resolve(); await Promise.resolve();
  expect(pending).toHaveLength(4);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  for (const resolve of pending) resolve(new Response(png, { headers: { 'content-type': 'image/png' } }));
  await generation;
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(fetchMock.mock.calls[4][1].body.getAll('image[]')).toHaveLength(4);
});

it('rejects unsafe references before downloading or generating', async () => {
  jest.mocked(assertSafeRemoteUrl).mockRejectedValueOnce(new Error('private address'));
  await expect(generateWithAzure({ ...options, referenceImages: ['https://localhost/a.png'] })).rejects.toMatchObject({ status: 400 });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  new Response('<svg></svg>', { headers: { 'content-type': 'image/svg+xml' } }),
  new Response('', { headers: { 'content-type': 'image/png' } }),
  new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) } }),
  new Response('redirected', { status: 302 }),
])('rejects invalid references without submitting a generation', async response => {
  fetchMock.mockResolvedValueOnce(response);
  await expect(generateWithAzure({ ...options, referenceImages: ['https://images.example.test/a.png'] })).rejects.toMatchObject({ status: 400 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(persistGeneratedImage).not.toHaveBeenCalled();
});

it.each([
  { size: '256x256' }, { size: '512x512' }, { size: '4000x1000' }, { size: '1025x1024' },
  { size: '3840x3840' }, { size: '3840x640' }, { size: '1024x1024', ratio: '16:9' },
  { size: 'auto', ratio: '16:9' }, { ratio: '5:4' }, { quality: 90 }, { quality: 'ultra' },
  { count: 0 }, { count: 5 }, { count: 1.5 }, { model: 'openai/gpt-image-2.5-sunburst' },
  { model: '' },
  { referenceImages: Array(5).fill('https://images.example.test/a.png') },
])('rejects invalid/unsupported image options before any request: %j', async extra => {
  await expect(generateWithAzure({ ...options, ...extra } as any)).rejects.toMatchObject({ status: 400 });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(persistGeneratedImage).not.toHaveBeenCalled();
});

it.each([
  { AZURE_OPENAI_IMAGE_API_KEY: '' }, { AZURE_OPENAI_IMAGE_DEPLOYMENT: '' },
  { AZURE_OPENAI_IMAGE_API_VERSION: 'invalid' }, { AZURE_OPENAI_IMAGE_ENDPOINT: 'http://test.openai.azure.com' },
  { AZURE_OPENAI_IMAGE_ENDPOINT: 'https://untrusted.example.test' },
  { AZURE_OPENAI_IMAGE_ENDPOINT: 'https://test.openai.azure.com/?key=invalid' },
  { AZURE_OPENAI_IMAGE_ENDPOINT: 'https://test.openai.azure.com/openai/deployments/chat' },
  { AZURE_OPENAI_IMAGE_ENDPOINT: 'https://test.services.ai.azure.com/mai/v1/images/generations' },
])('fails closed on invalid image configuration; never switches credentials: %j', async extra => {
  Object.assign(process.env, extra);
  await expect(generateWithAzure(options)).rejects.toMatchObject({ status: 503 });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('never substitutes the OpenRouter key when Azure credentials are missing', async () => {
  delete process.env.MICROSOFT_AZURE_OPENAI_API_KEY;
  await expect(generateWithAzure(options)).rejects.toMatchObject({ status: 503 });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([null, {}, { data: [] }, { data: [null] }, { data: [{ url: 'https://provider.example.test/image' }] },
  { data: [{ b64_json: 'invalid' }] }, { data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] },
  { data: [output.data[0], output.data[0]] }])('rejects invalid provider output before persistence: %j', async response => {
  fetchMock.mockResolvedValueOnce(json(response));
  await expect(generateWithAzure(options)).rejects.toMatchObject({ status: 502 });
  expect(persistGeneratedImage).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('retains successful partial output counts for route billing', async () => {
  fetchMock.mockResolvedValueOnce(json(output));
  const result = await generateWithAzure({ ...options, count: 2 });
  expect(result.images).toHaveLength(1);
  expect(persistGeneratedImage).toHaveBeenCalledTimes(1);
});

it.each(['gpt-image-2.5', 'gpt-image-1-custom-alias', 'my-image-deployment'])(
  'does not infer model capabilities from custom Azure deployment alias %s', async model => {
    fetchMock.mockResolvedValueOnce(json(output));
    await generateWithAzure({ ...options, model, ratio: '16:9', quality: 'max' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model, size: '1536x864', quality: 'max' });
  },
);

it.each([401, 404, 429, 500, 503])('does not retry/fallback or expose provider error bodies (HTTP %s)', async status => {
  const secret = randomBytes(32).toString('hex');
  fetchMock.mockResolvedValueOnce(json({ error: { message: secret } }, status));
  let message = '';
  try { await generateWithAzure(options); } catch (error) { message = String(error); }
  expect(message).toContain(`Azure image request failed (${status})`);
  expect(message).not.toContain(secret);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(persistGeneratedImage).not.toHaveBeenCalled();
});

it('redacts synthetic credentials and authenticated URLs in fetch errors and logs', async () => {
  const url = new URL('https://provider.example.test/image');
  url.username = randomBytes(12).toString('hex'); url.password = randomBytes(32).toString('hex');
  url.searchParams.set('token', randomBytes(32).toString('hex'));
  const key = process.env.MICROSOFT_AZURE_OPENAI_API_KEY!;
  const logs = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  fetchMock.mockRejectedValueOnce(new Error(`${key} ${url}`));
  let message = '';
  try { await generateWithAzure(options); } catch (error) { message = String(error); }
  for (const sensitive of [key, url.username, url.password, url.searchParams.get('token')!, url.toString()]) {
    expect(message + JSON.stringify(logs.mock.calls)).not.toContain(sensitive);
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
  logs.mockRestore();
});