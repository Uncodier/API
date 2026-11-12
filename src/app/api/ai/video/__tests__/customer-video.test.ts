import { createHash, randomBytes } from 'node:crypto';
import { withExecutionRouting, type ExecutionRoutingReference } from '@/lib/services/ai/customer-routing';
import { prepareCustomerVideo, validateCustomerMp4 } from '../customer-video';
import { startCustomerVideoJob } from '../customer-video-jobs';
import { resumeVideoJob } from '../openrouter-jobs';
import { persistCustomerVideo as persistGeneratedVideo } from '../customer-video-storage';
import { resolveCustomerCredential, getCustomerSelection } from '@/lib/integrations/openrouter/store';
import { CreditService } from '@/lib/services/billing/CreditService';

const mockCache = new Map<string, unknown>();
const mockClaims = new Set<string>();
const mockDurable = new Map<string, any>();
const mockRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args) } }));
jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: jest.fn(), getCustomerSelection: jest.fn() }));
jest.mock('@/lib/security/upstash-rest', () => ({
  sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
  getCachedJson: async (key: string) => mockCache.has(key) ? JSON.parse(JSON.stringify(mockCache.get(key))) : null,
  setCachedJson: jest.fn(async (key: string, value: unknown) => { mockCache.set(key, JSON.parse(JSON.stringify(value))); return true; }),
}));
jest.mock('../customer-video-storage', () => ({ persistCustomerVideo: jest.fn() }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: { deductCredits: jest.fn(), validateCredits: jest.fn() } }));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn() }));

const pin: ExecutionRoutingReference = { payer: 'customer', siteId: 'site-a', connectionId: 'connection-a', policyVersion: 2, credentialVersion: 3 };
const body = { site_id: pin.siteId, prompt: 'A quiet garden', duration_seconds: 4 };
const prepared = { model: 'vendor/video', prompt: body.prompt, duration: 4, aspect_ratio: '16:9' };
const secret = randomBytes(32).toString('hex');
const scoped = <T>(run: () => Promise<T>) => withExecutionRouting(pin, pin.siteId, run);
function box(type: string, ...contents: Buffer[]) {
  const payload = Buffer.concat(contents), header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8); header.write(type, 4); return Buffer.concat([header, payload]);
}
function mp4() {
  const sample = Buffer.alloc(78); sample.writeUInt16BE(640, 24); sample.writeUInt16BE(360, 26);
  const words = (...values: number[]) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v, i * 4)); return b; };
  const handler = Buffer.alloc(12); handler.write('vide', 8);
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0mp42'));
  const mdat = box('mdat', Buffer.from([1, 2, 3]));
  return Buffer.concat([ftyp, mdat,
    box('moov', box('mvhd', Buffer.alloc(20)), box('trak', box('tkhd', Buffer.alloc(20)),
      box('mdia', box('mdhd', Buffer.alloc(20)), box('hdlr', handler),
        box('minf', box('stbl', box('stsd', words(0, 1), box('avc1', sample,
          box('avcC', Buffer.from([1, 66, 0, 30, 255, 225, 0, 1, 103, 1, 0, 1, 104])))),
          box('stsz', words(0, 3, 1)), box('stts', words(0, 1, 1, 1000)),
          box('stsc', words(0, 1, 1, 1, 1)), box('stco', words(0, 1, ftyp.length + 8)))))))]);
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let fetchMock: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks(); mockCache.clear(); mockClaims.clear(); mockDurable.clear();
  process.env.OPENROUTER_ROUTING_STORAGE_READY = 'true';
  jest.mocked(resolveCustomerCredential).mockResolvedValue({ apiKey: secret,
    capabilities: { video: { modelId: prepared.model, status: 'unverified', mode: 'manual' } },
    catalog: [{ id: prepared.model, contextLength: null }] } as any);
  mockRpc.mockImplementation(async (name: string, input: any) => {
    if (name === 'openrouter_customer_video_save') {
      const previous = mockDurable.get(input.p_job.id);
      if (previous && (input.p_job.version ?? 0) !== previous.version) return { error: new Error('stale') };
      const saved = { ...input.p_job, version: (previous?.version ?? 0) + 1 };
      mockDurable.set(saved.id, JSON.parse(JSON.stringify(saved)));
      return { data: saved, error: null };
    }
    if (name === 'openrouter_customer_video_load') {
      return { data: [...mockDurable.values()].find(job => job.siteId === input.p_site_id
        && (input.p_job_id ? job.id === input.p_job_id : job.operationKey === input.p_operation_key)) ?? null, error: null };
    }
    if (name === 'openrouter_customer_dispatch') {
      const key = `${input.p_intent.site_id}:${input.p_intent.operation_key}`;
      const claimed = !mockClaims.has(key); mockClaims.add(key);
      return { data: { claimed, event_id: input.p_intent.event_id }, error: null };
    }
    return { error: null };
  });
  jest.mocked(persistGeneratedVideo).mockResolvedValue({ url: 'https://storage.example.test/video.mp4', mimeType: 'video/mp4' });
  fetchMock = jest.fn(async (url: string, init: RequestInit) => {
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    expect(init.redirect).toBe('error');
    if (url.endsWith('/models')) return json({ data: [{ id: prepared.model, supported_durations: [4], supported_aspect_ratios: ['16:9'] }] });
    if (init.method === 'POST') {
      expect(mockClaims.size).toBe(1);
      return json({ id: 'upstream-1', status: 'pending', polling_url: 'http://127.0.0.1/private' }, 202);
    }
    if (url.endsWith('/content?index=0')) return new Response(mp4(), { headers: { 'Content-Type': 'video/mp4' } });
    return json({ id: 'upstream-1', status: 'completed', generation_id: 'gen-1', usage: { cost: 0.4 }, unsigned_urls: ['http://169.254.169.254/secret'] });
  });
  global.fetch = fetchMock;
});

it('runs real customer prepare/submit/poll/download with durable claim, pinned credential and linked receipt', async () => {
  const accepted = await scoped(async () => startCustomerVideoJob(body, await prepareCustomerVideo(body), 'operation-1'));
  expect(accepted.status).toBe('pending'); expect(accepted.videos).toEqual([]);
  expect(await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'))).toEqual(accepted);
  const completed = await resumeVideoJob(pin.siteId, accepted.job_id!);
  expect(completed).toMatchObject({ status: 'completed', metadata: { payer: 'customer', cost: 0.4 } });
  expect(completed.videos).toHaveLength(1);
  expect(getCustomerSelection).not.toHaveBeenCalled();
  expect(resolveCustomerCredential).toHaveBeenLastCalledWith(pin);
  expect(persistGeneratedVideo).toHaveBeenCalledWith(expect.objectContaining({ eventId: completed.metadata.receipt_event_id,
    metadata: expect.objectContaining({ receipt_event_id: completed.metadata.receipt_event_id, execution_routing: pin }) }));
  expect(mockRpc).toHaveBeenCalledWith('openrouter_customer_receipt', expect.objectContaining({ p_receipt: expect.objectContaining({
    event_id: completed.metadata.receipt_event_id, connection_id: pin.connectionId, state: 'completed', model: null,
  }) }));
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  expect(fetchMock.mock.calls.every(([url]) => url.startsWith('https://openrouter.ai/api/v1/videos'))).toBe(true);
  expect(JSON.stringify([...mockCache.values()])).not.toContain(secret);
  expect(CreditService.deductCredits).not.toHaveBeenCalled(); expect(CreditService.validateCredits).not.toHaveBeenCalled();
});

it('never replays an accepted POST after all Redis state expires', async () => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  mockCache.clear();
  const retry = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  expect(retry.job_id).toBe(accepted.job_id);
  expect((await resumeVideoJob(pin.siteId, retry.job_id!)).status).toBe('completed');
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

it('keeps the SQL dispatch barrier even if the status records are unavailable after acceptance', async () => {
  await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  mockCache.clear(); mockDurable.clear();
  const retry = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  expect(retry.error).toContain('uncertain');
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

it('retains ambiguous upstream response without retrying the paid POST', async () => {
  fetchMock.mockRejectedValueOnce(new Error(secret));
  const first = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  mockCache.clear();
  const retry = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  expect(first.error).toContain('uncertain'); expect(retry.job_id).toBe(first.job_id);
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(JSON.stringify(retry)).not.toContain(secret);
});

it('does not submit after durable intent write failure', async () => {
  const original = mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation(async (name: string, input: any) => name === 'openrouter_customer_dispatch'
    ? { error: new Error(secret) } : original(name, input));
  const result = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  expect(result.error).toContain('uncertain'); expect(fetchMock).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(secret);
});

it('withholds artifacts on receipt failure and safely retries status without generation or storage replay', async () => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  const original = mockRpc.getMockImplementation()!;
  let fail = true;
  mockRpc.mockImplementation(async (name: string, input: any) => {
    if (name === 'openrouter_customer_receipt' && fail) { fail = false; return { error: new Error('receipt unavailable') }; }
    return original(name, input);
  });
  await expect(resumeVideoJob(pin.siteId, accepted.job_id!)).rejects.toThrow('reconciliation');
  expect((await resumeVideoJob(pin.siteId, accepted.job_id!)).status).toBe('completed');
  expect(persistGeneratedVideo).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

it('withholds output on asset failure without charging or replaying generation', async () => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  jest.mocked(persistGeneratedVideo).mockRejectedValueOnce(new Error('asset unavailable'));
  await expect(resumeVideoJob(pin.siteId, accepted.job_id!)).rejects.toThrow('asset unavailable');
  expect(mockRpc).not.toHaveBeenCalledWith('openrouter_customer_receipt', expect.anything());
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

it('rejects foreign site and revoked pin before any status dispatch', async () => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  fetchMock.mockClear();
  await expect(resumeVideoJob('site-b', accepted.job_id!)).rejects.toMatchObject({ status: 404 });
  jest.mocked(resolveCustomerCredential).mockRejectedValueOnce(new Error('revoked'));
  await expect(resumeVideoJob(pin.siteId, accepted.job_id!)).rejects.toThrow('revoked');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('records missing cost as uncertain, never zero or invented actual model evidence', async () => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  fetchMock.mockImplementationOnce(async () => json({ id: 'upstream-1', status: 'completed' }));
  const result = await resumeVideoJob(pin.siteId, accepted.job_id!);
  expect(result.metadata.cost).toBeUndefined();
  expect(mockRpc).toHaveBeenCalledWith('openrouter_customer_receipt', { p_receipt: expect.objectContaining({ state: 'uncertain', model: null }) });
});

it('fails unsupported options/model binding before paid dispatch', async () => {
  await expect(scoped(() => prepareCustomerVideo({ ...body, model: 'other/video' }))).rejects.toThrow();
  await expect(scoped(() => prepareCustomerVideo({ ...body, first_frame_url: 'http://127.0.0.1/a' }))).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('keeps provider failures terminal with attributed uncertain receipt, not platform fallback', async () => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  fetchMock.mockImplementationOnce(async () => json({ id: 'upstream-1', status: 'failed', error: secret }));
  const failed = await resumeVideoJob(pin.siteId, accepted.job_id!);
  expect(failed.status).toBe('failed'); expect(failed.videos).toEqual([]);
  expect(JSON.stringify(failed)).not.toContain(secret);
  expect(mockRpc).toHaveBeenCalledWith('openrouter_customer_receipt', { p_receipt: expect.objectContaining({ state: 'uncertain' }) });
  expect(persistGeneratedVideo).not.toHaveBeenCalled(); expect(CreditService.deductCredits).not.toHaveBeenCalled();
});

it('rejects spoofed status IDs before downloading any content', async () => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  fetchMock.mockImplementationOnce(async () => json({ id: 'foreign-job', status: 'completed' }));
  await expect(resumeVideoJob(pin.siteId, accepted.job_id!)).rejects.toThrow();
  expect(persistGeneratedVideo).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('rejects empty MP4 bytes even under a successful video MIME response', async () => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  fetchMock.mockImplementationOnce(async () => json({ id: 'upstream-1', status: 'completed' }));
  fetchMock.mockImplementationOnce(async () => new Response(Buffer.alloc(0), { headers: { 'Content-Type': 'video/mp4' } }));
  await expect(resumeVideoJob(pin.siteId, accepted.job_id!)).rejects.toThrow();
  expect(persistGeneratedVideo).not.toHaveBeenCalled();
});

it.each([Buffer.from('not video'), box('ftyp', Buffer.from('isom')), Buffer.concat([mp4(), Buffer.from([1])])])('rejects malformed or truncated MP4', data => {
  expect(() => validateCustomerMp4(data)).toThrow();
});
it('accepts nested MP4 structure but rejects a fake trak substring', () => {
  expect(() => validateCustomerMp4(mp4())).not.toThrow();
  expect(() => validateCustomerMp4(Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0mp42')), box('moov', Buffer.from('trak')), box('mdat', Buffer.from([1]))]))).toThrow();
});

it.each(['completed', 'failed'])('recovers accepted %s receipt with a lost ACK without repolling changed cost', async status => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  fetchMock.mockImplementationOnce(async () => json({ id: 'upstream-1', status, generation_id: 'gen-1', usage: { cost: 2 } }));
  const original = mockRpc.getMockImplementation()!;
  let receipt: unknown;
  mockRpc.mockImplementation(async (name, input) => {
    if (name === 'openrouter_customer_receipt') {
      if (!receipt) { receipt = structuredClone(input.p_receipt); return { error: new Error('accepted but ACK lost') }; }
      if (JSON.stringify(receipt) !== JSON.stringify(input.p_receipt)) return { error: new Error('Receipt conflict') };
    }
    return original(name, input);
  });
  await expect(resumeVideoJob(pin.siteId, accepted.job_id!)).rejects.toThrow('reconciliation');
  const snapshot = mockDurable.get(accepted.job_id!).settlement;
  expect(snapshot.receipt).toEqual(receipt);
  mockCache.clear(); fetchMock.mockClear();
  // If recovery regresses to provider polling this now returns differing evidence.
  fetchMock.mockImplementation(async () => json({ id: 'upstream-1', status, generation_id: 'gen-1', usage: { cost: 9 } }));
  jest.mocked(resolveCustomerCredential).mockRejectedValue(new Error('rotated'));
  expect(await resumeVideoJob(pin.siteId, accepted.job_id!)).toMatchObject({ status, metadata: { cost: 2 } });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mockDurable.get(accepted.job_id!).settlement).toEqual(snapshot);
  expect(mockClaims.size).toBe(1);
});

it.each(['completed', 'failed'])('retrieves terminal %s after revocation without resolving credentials', async status => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  fetchMock.mockImplementationOnce(async () => json({ id: 'upstream-1', status }));
  const terminal = await resumeVideoJob(pin.siteId, accepted.job_id!);
  mockCache.clear(); fetchMock.mockClear(); jest.mocked(resolveCustomerCredential).mockClear();
  jest.mocked(resolveCustomerCredential).mockRejectedValue(new Error('revoked'));
  expect(await resumeVideoJob(pin.siteId, accepted.job_id!)).toEqual(terminal);
  expect(resolveCustomerCredential).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  await expect(resumeVideoJob('other-site', accepted.job_id!)).rejects.toMatchObject({ status: 404 });
});

it('recovers the final save ACK loss without delivering another receipt or generation', async () => {
  const accepted = await scoped(() => startCustomerVideoJob(body, prepared, 'operation-1'));
  const original = mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation(async (name, input) => {
    const result = await original(name, input);
    if (name === 'openrouter_customer_video_save' && input.p_job.status === 'completed') return { error: new Error('ACK lost') };
    return result;
  });
  await expect(resumeVideoJob(pin.siteId, accepted.job_id!)).rejects.toThrow('retry status only');
  const receipts = mockRpc.mock.calls.filter(([name]) => name === 'openrouter_customer_receipt').length;
  mockCache.clear(); fetchMock.mockClear();
  expect((await resumeVideoJob(pin.siteId, accepted.job_id!)).status).toBe('completed');
  expect(mockRpc.mock.calls.filter(([name]) => name === 'openrouter_customer_receipt')).toHaveLength(receipts);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['stsz', 'stts', 'stsc', 'stco', 'avcC'])('rejects a movie missing %s despite an mdat and video track', type => {
  const data = Buffer.from(mp4());
  data.write('free', data.indexOf(type));
  expect(() => validateCustomerMp4(data)).toThrow();
});
it('rejects zero samples and sample offsets outside mdat', () => {
  const empty = Buffer.from(mp4()); empty.writeUInt32BE(0, empty.indexOf('stsz') + 12);
  expect(() => validateCustomerMp4(empty)).toThrow();
  const bogus = Buffer.from(mp4()); bogus.writeUInt32BE(0, bogus.indexOf('stco') + 12);
  expect(() => validateCustomerMp4(bogus)).toThrow();
});