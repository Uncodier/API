import { generateAndCacheImageStep } from '../steps';
import { ImageGenerationService } from '@/lib/services/image/ImageGenerationService';
import { uploadToCache } from '@/lib/services/image/promptImageCache';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';

jest.mock('@/lib/services/image/ImageGenerationService', () => ({ ImageGenerationService: { generateImage: jest.fn() } }));
jest.mock('@/lib/services/image/promptImageCache', () => ({ uploadToCache: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn() }));
jest.mock('@/lib/services/billing/CreditService', () => { throw new Error('Public image step must not own billing'); });

const originalFetch = global.fetch;
const fetchMock = jest.fn();
const insert = jest.fn();
const imageUrl = 'https://storage.example.test/generated.png';
const cacheUrl = 'https://storage.example.test/cache/hash.png';

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock;
  fetchMock.mockResolvedValue(new Response(Buffer.from('generated-image'), { headers: { 'content-type': 'image/png' } }));
  jest.mocked(ImageGenerationService.generateImage).mockResolvedValue({ success: true, provider: 'azure', images: [{ url: imageUrl }], metadata: { model: 'image-deployment', n: 1, generated_at: new Date().toISOString() } });
  jest.mocked(assertSafeRemoteUrl).mockResolvedValue(new URL(imageUrl));
  jest.mocked(uploadToCache).mockResolvedValue({ url: cacheUrl, path: 'cache/hash.png' });
  jest.mocked(supabaseAdmin.from).mockReturnValue({ insert } as any);
  insert.mockResolvedValue({ error: null });
});
afterAll(() => { global.fetch = originalFetch; });

it.each(['256x256', '512x512', '1024x1024'] as const)('generates tiny/cache square size %s at Azure 1024x1024 without changing the cache hash', async size => {
  expect(await generateAndCacheImageStep('cat', 'site-id', size, '1:1', 'original-hash')).toEqual({ success: true });
  expect(ImageGenerationService.generateImage).toHaveBeenCalledWith({ prompt: 'cat', site_id: 'site-id', size: '1024x1024', ratio: '1:1', provider: 'azure' });
  expect(uploadToCache).toHaveBeenCalledWith('original-hash', Buffer.from('generated-image'), 'image/png');
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ site_id: 'site-id', metadata: expect.objectContaining({ provider: 'azure', model: 'image-deployment', prompt_hash: 'original-hash' }) }));
  expect(ImageGenerationService.generateImage).toHaveBeenCalledTimes(1);
});

it.each(['16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const)('leaves Azure adapter responsible for actual dimensions for ratio %s', async ratio => {
  await generateAndCacheImageStep('cat', 'site-id', '256x256', ratio, 'original-hash');
  expect(ImageGenerationService.generateImage).toHaveBeenCalledWith({ prompt: 'cat', site_id: 'site-id', size: undefined, ratio, provider: 'azure' });
});

it('preserves the system site for platform billing and does not create a customer asset', async () => {
  const systemSite = '00000000-0000-0000-0000-000000000000';
  await generateAndCacheImageStep('cat', systemSite, '512x512', undefined, 'platform-hash');
  expect(ImageGenerationService.generateImage).toHaveBeenCalledWith(expect.objectContaining({ site_id: systemSite, provider: 'azure', size: '1024x1024' }));
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('downloads generated images only through the safe URL check', async () => {
  await generateAndCacheImageStep('cat', 'site-id', '1024x1024', '1:1', 'hash');
  expect(assertSafeRemoteUrl).toHaveBeenCalledWith(imageUrl);
  expect(fetchMock).toHaveBeenCalledWith(new URL(imageUrl), expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
});

it('does not retry, download or cache when Azure image generation fails', async () => {
  jest.mocked(ImageGenerationService.generateImage).mockResolvedValueOnce({ success: false, provider: 'azure', images: [], error: 'Quota exceeded' });
  await expect(generateAndCacheImageStep('cat', 'site-id', '256x256', '1:1', 'hash')).rejects.toThrow('Quota exceeded');
  expect(ImageGenerationService.generateImage).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(uploadToCache).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});