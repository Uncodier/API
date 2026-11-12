import { randomBytes } from 'node:crypto';
import { VideoGenerationService } from '@/lib/services/video/VideoGenerationService';
import { resolveHttpExecutionRouting } from '@/lib/services/ai/customer-routing-http';
import { persistGeneratedVideo } from '../video-storage';

const mockUpload = jest.fn(), mockInsert = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  storage: { from: () => ({ upload: mockUpload, getPublicUrl: () => ({ data: { publicUrl: 'https://storage.example.test/video.mp4' } }) }) },
  from: (table: string) => table === 'assets' ? { insert: mockInsert }
    : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: 'owner' } }) }) }) },
} }));
jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: jest.fn(), getCustomerSelection: jest.fn() }));
const siteId = '11111111-1111-4111-8111-111111111111';
const routing = { payer: 'customer' as const, siteId, connectionId: 'connection-a', policyVersion: 2, credentialVersion: 3 };
beforeEach(() => {
  jest.clearAllMocks(); process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
  mockUpload.mockResolvedValue({ data: { path: 'stored.mp4' }, error: null });
  mockInsert.mockResolvedValue({ error: null });
});
it('signs host routing, sends stable idempotency and strips authority from JSON', async () => {
  global.fetch = jest.fn(async (url, init) => {
    expect(init?.headers).toMatchObject({ 'Idempotency-Key': 'durable-video-1' });
    const request = new Request(url, init);
    expect(await resolveHttpExecutionRouting(request, siteId)).toEqual(routing);
    const body = JSON.parse(init?.body as string);
    expect(body.executionRouting).toBeUndefined(); expect(body.operationId).toBeUndefined();
    return new Response(JSON.stringify({ provider: 'openrouter', status: 'pending', job_id: siteId, videos: [] }), { status: 202 });
  });
  const result = await VideoGenerationService.generateVideo({ prompt: 'Garden', site_id: siteId,
    executionRouting: routing, operationId: 'durable-video-1' });
  expect(result).toMatchObject({ success: true, status: 'pending', job_id: siteId, videos: [] });
});
it('polls only the existing job and never resubmits', async () => {
  global.fetch = jest.fn(async (_url, init) => {
    expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
    return new Response(JSON.stringify({ provider: 'openrouter', status: 'in_progress', job_id: siteId, videos: [] }));
  });
  expect((await VideoGenerationService.getVideoJob(siteId, siteId)).status).toBe('in_progress');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
it('fails closed when a customer caller has no stable operation identity', async () => {
  global.fetch = jest.fn();
  expect(await VideoGenerationService.generateVideo({ prompt: 'Garden', site_id: siteId, executionRouting: routing }))
    .toMatchObject({ success: false, error: 'Customer video generation requires a stable operationId' });
  expect(global.fetch).not.toHaveBeenCalled();
});
it('strict customer asset linkage failure is fatal while legacy remains best effort', async () => {
  const input = { buffer: Buffer.from('fixture'), mimeType: 'video/mp4', siteId, prompt: 'Garden', model: 'vendor/video',
    metadata: { payer: 'customer', receipt_event_id: 'receipt-1' } };
  mockInsert.mockResolvedValue({ error: { message: 'asset insert failed' } });
  await expect(persistGeneratedVideo({ ...input, strict: true })).rejects.toThrow('Customer video asset persistence failed');
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ site_id: siteId,
    metadata: expect.objectContaining({ receipt_event_id: 'receipt-1' }) }));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await expect(persistGeneratedVideo(input)).resolves.toMatchObject({ mimeType: 'video/mp4' });
  warn.mockRestore();
});
it('requires upload acknowledgement before asset creation', async () => {
  mockUpload.mockResolvedValue({ data: null, error: null });
  await expect(persistGeneratedVideo({ buffer: Buffer.from('fixture'), mimeType: 'video/mp4', siteId,
    prompt: 'Garden', model: 'vendor/video', metadata: {}, strict: true })).rejects.toThrow('Video upload failed');
  expect(mockInsert).not.toHaveBeenCalled();
});