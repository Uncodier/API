import { createHash } from 'node:crypto';
import { startCustomerVideoJob, resumeCustomerVideoJob } from '../customer-video-jobs';
import { loadCustomerVideoJob } from '../customer-video-store';
import { persistCustomerVideo } from '../customer-video-storage';
import { customerVideoJob, downloadCustomerVideo } from '../customer-video';
import { withExecutionRouting } from '@/lib/services/ai/customer-routing';

const mockJobs = new Map<string, any>(), mockAssets = new Map<string, any>(), mockObjects = new Map<string, Buffer>();
const mockReceipts = new Map<string, any>(), mockCache = new Map<string, any>();
let mockFault = '', mockDeliveries = 0;
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const mockRpc = jest.fn(async (name: string, input: any) => {
  if (name === 'openrouter_customer_video_load') return { data: [...mockJobs.values()].find(job => job.siteId === input.p_site_id
    && (input.p_job_id ? job.id === input.p_job_id : job.operationKey === input.p_operation_key)) ?? null };
  if (name === 'openrouter_customer_video_save') {
    const job = clone(input.p_job), previous = mockJobs.get(job.id);
    if (mockFault === 'job-save' && job.videos?.length) { mockFault = ''; return { error: {} }; }
    if (previous && job.version !== previous.version) return { error: {} };
    job.version = (previous?.version ?? 0) + 1; mockJobs.set(job.id, job);
    return { data: clone(job) };
  }
  if (name === 'openrouter_customer_receipt') {
    mockDeliveries++;
    const receipt = clone(input.p_receipt), previous = mockReceipts.get(receipt.event_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) return { error: { message: 'Receipt conflict' } };
    mockReceipts.set(receipt.event_id, receipt);
    if (mockFault === 'receipt-ack') { mockFault = ''; return { error: {} }; }
    return { error: null };
  }
  throw new Error(`Unexpected RPC ${name}`);
});
const mockUpload = jest.fn(async (path: string, buffer: Buffer, options: any) => {
  expect(options.upsert).toBe(false);
  if (mockObjects.has(path)) return { error: { statusCode: '409' } };
  mockObjects.set(path, Buffer.from(buffer));
  if (mockFault === 'upload-ack') { mockFault = ''; throw new Error('Upload ACK lost'); }
  return { data: { path } };
});
const mockInsert = jest.fn(async (asset: any) => {
  if (mockAssets.has(asset.id)) return { error: { code: '23505' } };
  mockAssets.set(asset.id, clone(asset));
  if (mockFault === 'insert-ack') { mockFault = ''; throw new Error('Insert ACK lost'); }
  return { error: null };
});
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  rpc: (...args: [string, any]) => mockRpc(...args),
  storage: { from: () => ({ upload: mockUpload,
    download: async (path: string) => ({ data: new Blob([new Uint8Array(mockObjects.get(path)!)]) }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.example.test/${path}` } }),
  }) },
  from: (table: string) => ({ insert: mockInsert, select: () => ({ eq: (_key: string, value: string) => ({
    maybeSingle: async () => ({ data: table === 'assets' ? mockAssets.get(value) ?? null : { user_id: 'owner' } }),
  }) }) }),
} }));
jest.mock('@/lib/security/upstash-rest', () => ({
  sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
  getCachedJson: async (key: string) => mockCache.get(key) ?? null,
  setCachedJson: async (key: string, value: unknown) => { mockCache.set(key, clone(value)); return true; },
}));
jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: async () => ({}) }));
jest.mock('../customer-video', () => ({ customerVideoJob: jest.fn(), downloadCustomerVideo: jest.fn() }));

const siteId = '11111111-1111-4111-8111-111111111111';
const routing = { payer: 'customer' as const, siteId, connectionId: '22222222-2222-4222-8222-222222222222', policyVersion: 1, credentialVersion: 1 };
const prepared = { model: 'vendor/video', prompt: 'Garden', duration: 4, aspect_ratio: '16:9' };
const input = { buffer: Buffer.from('offline adapter bytes'), mimeType: 'video/mp4', siteId,
  eventId: '44444444-4444-4444-8444-444444444444', prompt: 'Garden', model: 'vendor/video', metadata: {} };
beforeEach(() => {
  jest.clearAllMocks(); mockJobs.clear(); mockAssets.clear(); mockObjects.clear(); mockReceipts.clear(); mockCache.clear();
  mockFault = ''; mockDeliveries = 0;
  jest.mocked(customerVideoJob).mockImplementation(async request => typeof request === 'string'
    ? { id: 'provider-1', status: 'completed', generation_id: 'gen-1', usage: { cost: 2 } }
    : { id: 'provider-1', status: 'in_progress' });
  jest.mocked(downloadCustomerVideo).mockResolvedValue({ buffer: input.buffer, mimeType: input.mimeType });
});

it.each(['upload-ack', 'insert-ack', 'job-save', 'receipt-ack'])('recovers %s across the real lifecycle, store, artifact and receipt modules', async fault => {
  const accepted = await withExecutionRouting(routing, siteId, () => startCustomerVideoJob({ site_id: siteId, prompt: 'Garden' }, prepared, 'one-operation'));
  const resume = async () => resumeCustomerVideoJob(clone((await loadCustomerVideoJob(siteId, { id: accepted.job_id! }))!));
  mockFault = fault;
  await expect(resume()).rejects.toThrow();
  expect(mockJobs.get(accepted.job_id!).status).toBe('in_progress');
  mockCache.clear();
  const completed = await resume();
  expect(completed.status).toBe('completed');
  expect(completed.videos).toHaveLength(1);
  expect(mockObjects.size).toBe(1); expect(mockAssets.size).toBe(1); expect(mockReceipts.size).toBe(1);
  expect(jest.mocked(customerVideoJob).mock.calls.filter(([request]) => typeof request !== 'string')).toHaveLength(1);
  expect(jest.mocked(customerVideoJob).mock.calls.filter(([request]) => typeof request === 'string')).toHaveLength(1);
  const asset = [...mockAssets.values()][0];
  expect(asset.id).toBe(completed.metadata.receipt_event_id);
  expect(asset.metadata.storage_path).toBe(`${siteId}/customer/${asset.id}.mp4`);
  const calls = mockDeliveries;
  expect(await resume()).toEqual(completed); expect(mockDeliveries).toBe(calls);
});

it('racing storage writers converge on one object and one asset', async () => {
  const [a, b] = await Promise.all([persistCustomerVideo(input), persistCustomerVideo(input)]);
  expect(a).toEqual(b); expect(mockObjects.size).toBe(1); expect(mockAssets.size).toBe(1);
  expect(mockInsert).toHaveBeenCalledTimes(2);
});
it('does not overwrite a conflicting object after ambiguous upload', async () => {
  mockObjects.set(`${siteId}/customer/${input.eventId}.mp4`, Buffer.from('different bytes'));
  await expect(persistCustomerVideo(input)).rejects.toThrow('storage conflict');
  expect(mockAssets.size).toBe(0);
});
it('rejects a conflicting asset identity rather than overwriting it', async () => {
  mockAssets.set(input.eventId, { site_id: 'other-site', file_path: 'https://storage.example.test/foreign' });
  await expect(persistCustomerVideo(input)).rejects.toThrow('identity conflict');
  expect(mockUpload).not.toHaveBeenCalled();
});