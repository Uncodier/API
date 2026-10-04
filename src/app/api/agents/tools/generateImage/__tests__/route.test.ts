import { NextRequest } from 'next/server';
import { GET, POST } from '../route';
import { POST as generateImage } from '@/app/api/ai/image/route';

jest.mock('@/app/api/ai/image/route', () => ({ POST: jest.fn() }));
jest.mock('@/lib/services/billing/CreditService', () => { throw new Error('Image tool route must not own billing'); });

beforeEach(() => jest.clearAllMocks());

it('advertises Azure as the only image provider', async () => {
  expect(await (await GET()).json()).toEqual({ message: 'AI Image Generation Tool API', providers: ['azure'], default_provider: 'azure', required_fields: ['prompt', 'site_id'] });
});

it.each([200, 401, 403, 429, 502])('delegates the original request and retains authorization/billing response status %s', async status => {
  const request = new NextRequest('https://api.example.test/api/agents/tools/generateImage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'cat', site_id: 'site-id', provider: 'azure', model: 'image-deployment' }),
  });
  const payload = status === 200 ? { provider: 'azure', images: [{ url: 'https://storage.example.test/image.png' }] } : { error: 'Rejected by image API' };
  jest.mocked(generateImage).mockResolvedValueOnce(new Response(JSON.stringify(payload), { status, headers: { 'X-Request-ID': 'test-request-id' } }) as any);
  const response = await POST(request);
  expect(generateImage).toHaveBeenCalledWith(request);
  expect(generateImage).toHaveBeenCalledTimes(1);
  expect(response.status).toBe(status);
  expect(response.headers.get('X-Request-ID')).toBe('test-request-id');
  expect(await response.json()).toEqual({ ...payload, success: status === 200 });
});