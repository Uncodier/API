import { randomUUID, webcrypto } from 'node:crypto';
const mockRpc = jest.fn();
const mockSend = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args) } }));
jest.mock('@/app/api/agents/tools/sendEmail/core', () => ({ sendEmailCore: (...args: unknown[]) => mockSend(...args) }));
import { POST } from '../route';

const siteId = randomUUID();
const key = `setup-email-v1:${'a'.repeat(64)}`;
const body = { operation_key: key, site_id: siteId, email: 'owner@example.test', subject: 'Setup update', message: 'Your agents are ready.' };
const receipt = { success: true, status: 'sent', messageId: 'provider-id', recipient: body.email, sent_at: '2026-10-07T00:00:00.000Z' };
const request = (payload: unknown = body, headers: Record<string, string> = { 'x-api-key': process.env.SERVICE_API_KEY! }) =>
  new Request('https://api.example.test/api/site/setup/email', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
const result = async (req = request()) => { const response = await POST(req); return { status: response.status, body: await response.json() }; };
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  process.env.SERVICE_API_KEY = randomUUID();
  mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => ({ data: name.startsWith('claim')
    ? { outcome: 'acquired' } : { outcome: args.p_state, receipt: args.p_receipt }, error: null }));
  mockSend.mockResolvedValue({ success: true, status: 'sent', external_message_id: 'provider-id' });
});

describe('setup email service-only dispatcher', () => {
  it('uses private no-store for receipts and authorization errors', async () => {
    for (const req of [request(), request(body, {})]) expect((await POST(req)).headers.get('cache-control')).toBe('private, no-store');
  });
  it('requires JSON and bounds bytes including a dishonest absent content length', async () => {
    expect((await result(request(body, { 'x-api-key': process.env.SERVICE_API_KEY!, 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await result(request({ ...body, message: 'x'.repeat(140_000) }))).status).toBe(413);
    expect(mockSend).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{}, { 'x-api-key': randomUUID() }, { 'x-api-key-data': '{"isService":true}', 'x-auth-validated': 'true', 'x-auth-user-id': randomUUID() }])('rejects missing/browser/forged authorization before database access %p', async headers => {
    expect((await result(request(body, headers))).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  });
  it('honors canonical credential precedence and requires configured service secret', async () => {
    expect((await result(request(body, { 'x-api-key': randomUUID(), authorization: `Bearer ${process.env.SERVICE_API_KEY}` }))).status).toBe(401);
    delete process.env.SERVICE_API_KEY;
    expect((await result(request(body, { authorization: `Bearer ${randomUUID()}` }))).status).toBe(401);
  });
  it.each([{ ...body, user_id: randomUUID() }, { ...body, tenant_id: randomUUID() }, { ...body, from: 'spoof@example.test' }, { ...body, site_id: 'invalid' }, { ...body, email: 'a@b.test\r\nBcc:bad@b.test' }, { ...body, subject: '\nInjected' }, { ...body, operation_key: 'arbitrary' }])('rejects untrusted or invalid delivery fields %p', async input => {
    expect((await result(request(input))).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('uses trusted site validation in atomic claim and calls existing core once with no ambiguous fallback', async () => {
    expect(await result()).toMatchObject({ status: 200, body: { success: true, status: 'sent', messageId: 'provider-id' } });
    expect(mockRpc.mock.calls[0]).toEqual(['claim_setup_email_delivery', expect.objectContaining({ p_site_id: siteId, p_payload: { site_id: siteId, email: body.email, subject: body.subject, message: body.message, omit_signature: true }, p_claim_token: expect.any(String) })]);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ site_id: siteId, omit_signature: true, disable_provider_fallback: true }));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it('returns prior actual sent receipt without calling core/Redis even if Redis would fail', async () => {
    mockRpc.mockResolvedValue({ data: { outcome: 'sent', receipt }, error: null });
    mockSend.mockRejectedValue(new Error('Redis down'));
    expect(await result()).toEqual({ status: 200, body: { ...receipt, replayed: true } });
    expect(mockSend).not.toHaveBeenCalled();
  });
  it.each(['claimed', 'uncertain'])('never reclaims/resends %s attempt', async outcome => {
    mockRpc.mockResolvedValue({ data: { outcome }, error: null });
    expect(await result()).toMatchObject({ status: 200, body: { success: false, unconfirmed: true, skipped: true } });
    expect(mockSend).not.toHaveBeenCalled();
  });
  it('fails closed on missing site, conflict, unavailable storage, or corrupt sent receipt', async () => {
    for (const [data, error, status] of [
      [{ outcome: 'site_unavailable' }, null, 404], [{ outcome: 'conflict' }, null, 409],
      [null, { message: 'Missing table' }, 503], [{ outcome: 'sent', receipt: { ...receipt, messageId: '' } }, null, 200],
    ] as const) {
      mockRpc.mockResolvedValue({ data, error });
      expect((await result()).status).toBe(status);
    }
    expect(mockSend).not.toHaveBeenCalled();
  });
  it.each([{ success: true, status: 'queued', email_id: 'queued' }, { success: true, status: 'sent' }, { success: false, error: { code: 'AGENTMAIL_FAILED', message: 'Accepted then timed out' } }])('records uncertainty rather than success or a resend for %p', async response => {
    mockSend.mockResolvedValue(response);
    expect(await result()).toMatchObject({ status: 200, body: { success: false, status: 'uncertain', unconfirmed: true } });
    expect(mockRpc.mock.calls[1][1]).toMatchObject({ p_state: 'uncertain' });
  });
  it('records accepted-but-lost confirmation and does not resend on retry', async () => {
    mockSend.mockRejectedValue(new Error('Lost acceptance confirmation'));
    expect((await result()).body.unconfirmed).toBe(true);
    mockRpc.mockResolvedValue({ data: { outcome: 'uncertain' }, error: null });
    await result();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it('does not pretend confirmed success if send succeeded but final receipt acknowledgment was lost', async () => {
    mockRpc.mockResolvedValueOnce({ data: { outcome: 'acquired' }, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'Lost DB response' } });
    expect((await result()).body).toMatchObject({ success: false, unconfirmed: true, reason: 'receipt_confirmation_unavailable' });
    mockRpc.mockResolvedValue({ data: { outcome: 'sent', receipt }, error: null });
    expect((await result()).body).toMatchObject({ success: true, replayed: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it.each(['SITE_CONFIG_NOT_FOUND', 'RATE_LIMITED', 'EMAIL_NOT_CONFIGURED'])('stores definite pre-delivery %s skips without future resend', async code => {
    mockSend.mockResolvedValue({ success: false, error: { code, message: 'No send attempted' } });
    expect((await result()).body).toMatchObject({ success: false, status: 'skipped', skipped: true, reason: code });
  });
});