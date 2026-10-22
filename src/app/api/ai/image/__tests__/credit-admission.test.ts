jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: jest.fn(async () => null),
  getAuthenticatedRateIdentity: jest.fn(() => 'internal'), isInternalServiceRequest: jest.fn(() => true) }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn(async () => true) }));
jest.mock('@/lib/services/ai/media-instance-access', () => ({ mediaInstanceBelongsToSite: jest.fn(async () => true) }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn() } }));
jest.mock('../provider-azure', () => ({ generateWithAzure: jest.fn(), validateAzureImageOptions: jest.fn() }));
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { generateWithAzure, validateAzureImageOptions } from '../provider-azure';
import { ImageAdmissionRejectedError } from '../image-types';
import { MediaRequestError } from '@/lib/services/image/media-request-error';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isInternalServiceRequest } from '@/lib/security/request-rate-limit';
import { canAccessSite } from '@/lib/security/site-access';
import { mediaInstanceBelongsToSite } from '@/lib/services/ai/media-instance-access';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';

const site = randomUUID();
const output = { provider: 'azure' as const, images: [{ url: 'https://example.invalid/image.png', b64_json: null }] };
const call = (body = {}, key: string | null = `workflow-image:${randomUUID()}`) => POST(new NextRequest('https://example.invalid/api/ai/image', {
  method: 'POST', headers: key ? { 'Idempotency-Key': key } : {}, body: JSON.stringify({ prompt: 'cat', site_id: site, ...body }),
}));
const rpc = supabaseAdmin.rpc as unknown as jest.Mock<Promise<{ data: unknown; error: unknown }>, [string, Record<string, unknown>]>;
const names = () => rpc.mock.calls.map(([name]) => name);
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(isInternalServiceRequest).mockReturnValue(true);
  jest.mocked(canAccessSite).mockResolvedValue(true);
  jest.mocked(mediaInstanceBelongsToSite).mockResolvedValue(true);
  jest.mocked(enforceRequestRateLimit).mockResolvedValue(null);
  rpc.mockImplementation(async (name,params) => ({ error: null, data: name.startsWith('hold_')
    ? { success: true, created: true, state: 'reserved' }
    : { success: true, charged: Number(params.p_count)/10,
      state: name.startsWith('dispatch_') ? 'dispatched' : name.startsWith('settle_') ? 'settled' : 'released' } }) as any);
  jest.mocked(generateWithAzure).mockImplementation(async opts => { await opts.beforeDispatch?.(); return output; });
});
it('holds then one-time dispatch then settles before releasing output, without CreditService deduction', async () => {
  expect((await call({ n: 2 })).status).toBe(200);
  expect(names()).toEqual(['hold_image_generation_credits', 'dispatch_image_generation_reservation', 'settle_image_generation_reservation']);
  expect(rpc.mock.calls[0][1]).toMatchObject({ p_count: 2 });
  expect(rpc.mock.calls[2][1]).toMatchObject({ p_count: 1 });
});
it.each(['dispatched', 'pending', 'settled', 'released', 'reserved'])('does not replay an existing %s operation', async state => {
  rpc.mockResolvedValueOnce({ data: { success: true, created: false, state }, error: null } as any);
  expect((await call()).status).toBe(409);
  expect(generateWithAzure).not.toHaveBeenCalled(); expect(names()).toHaveLength(1);
});
it('insufficient balance denies generation with 402', async () => {
  rpc.mockResolvedValueOnce({ data: { success: false, code: 'INSUFFICIENT_CREDITS' }, error: null } as any);
  expect((await call()).status).toBe(402); expect(generateWithAzure).not.toHaveBeenCalled();
});
it('invalid configuration/parameters fail before hold or dispatch', async () => {
  jest.mocked(validateAzureImageOptions).mockImplementationOnce(() => { throw new MediaRequestError('Unsupported size', 400); });
  expect((await call()).status).toBe(400); expect(rpc).not.toHaveBeenCalled();
});
it.each(['hold', 'dispatch', 'settle'])('lost %s acknowledgement never returns output, retries, or releases ambiguously', async phase => {
  rpc.mockImplementation(async name => {
    if (name.startsWith(`${phase}_`)) throw new Error('Lost database acknowledgement');
    return { data: { success: true, created: true, state: name.startsWith('hold_') ? 'reserved' : name.startsWith('dispatch_') ? 'dispatched' : 'settled' }, error: null } as any;
  });
  const result = await call(); expect(result.status).not.toBe(200);
  expect(await result.text()).not.toContain(output.images[0].url);
  expect(names()).not.toContain('release_image_generation_reservation');
  expect(generateWithAzure).toHaveBeenCalledTimes(phase === 'hold' ? 0 : 1);
});
it('timeout, storage failure and malformed output retain pending holds', async () => {
  jest.mocked(generateWithAzure).mockImplementationOnce(async opts => { await opts.beforeDispatch?.(); throw new Error('timeout'); });
  expect((await call()).status).toBe(500);
  expect(names()).toEqual(['hold_image_generation_credits', 'dispatch_image_generation_reservation', 'mark_image_generation_reservation_pending']);
});
it('trusted confirmed rejection releases while a spoofed error name does not', async () => {
  jest.mocked(generateWithAzure).mockImplementationOnce(async opts => { await opts.beforeDispatch?.(); throw new ImageAdmissionRejectedError('Rejected'); });
  expect((await call()).status).toBe(502);
  expect(names()).toContain('release_image_generation_reservation');
  rpc.mockClear();
  jest.mocked(generateWithAzure).mockImplementationOnce(async opts => { await opts.beforeDispatch?.(); throw Object.assign(new Error('uncertain'), { name: 'ImageAdmissionRejectedError' }); });
  await call(); expect(names()).not.toContain('release_image_generation_reservation');
});
it('pre-dispatch reference failure releases only its original hold', async () => {
  jest.mocked(generateWithAzure).mockRejectedValueOnce(new MediaRequestError('Invalid reference', 400));
  expect((await call()).status).toBe(400);
  expect(rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_reason: 'not_dispatched' });
});
it('internal system calls remain exempt; public caller cannot select server idempotency', async () => {
  expect((await call({ site_id: '00000000-0000-0000-0000-000000000000' })).status).toBe(200);
  expect(rpc).not.toHaveBeenCalled();
  jest.mocked(isInternalServiceRequest).mockReturnValue(false);
  expect((await call()).status).toBe(400); expect(rpc).not.toHaveBeenCalled();
});