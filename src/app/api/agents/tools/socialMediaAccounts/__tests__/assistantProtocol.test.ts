import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { OutstandClient } from '@/lib/integrations/outstand/client';
import { randomBytes } from 'node:crypto';

const listAccounts = jest.fn<OutstandClient['listAccounts']>();
const getOutstandClient = jest.fn(() => ({ listAccounts }));
jest.unstable_mockModule('@/lib/integrations/outstand/client', () => ({ getOutstandClient }));
let socialMediaAccountsTool: typeof import('../assistantProtocol')['socialMediaAccountsTool'];
beforeAll(async () => {
  ({ socialMediaAccountsTool } = await import('../assistantProtocol'));
});

const siteId = 'authorized-site';

describe('socialMediaAccountsTool', () => {
  beforeEach(() => {
    listAccounts.mockReset();
    getOutstandClient.mockReset().mockReturnValue({ listAccounts });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('returns a flat sanitized DTO list with inactive flags retained for discovery', async () => {
    listAccounts.mockResolvedValue({
      success: true,
      data: [{ id: 'opaque', network: 'instagram', username: 'name', isActive: 0, tenant_id: siteId, accessToken: 'hidden' }],
      count: 1, total: 1, limit: 100, offset: 0,
    });
    await expect(socialMediaAccountsTool(siteId).execute({})).resolves.toEqual({
      success: true, data: [{ id: 'opaque', network: 'instagram', username: 'name', isActive: false }],
    });
    expect(listAccounts).toHaveBeenCalledWith(siteId, { tenantId: siteId, limit: 100, offset: 0 });
  });

  it('returns successful empty data only for a successful empty provider collection', async () => {
    listAccounts.mockResolvedValue({ success: true, accounts: [] });
    await expect(socialMediaAccountsTool(siteId).execute({})).resolves.toEqual({ success: true, data: [] });
  });

  it.each([
    [{ success: false, data: [], error: 'sensitive upstream error' }, 'ACCOUNT_PROVIDER_ERROR'],
    [{ success: true, data: null }, 'INVALID_ACCOUNT_RESPONSE'],
    [{ success: true, data: [{ tenant_id: 'other-site' }] }, 'ACCOUNT_SCOPE_MISMATCH'],
  ])('returns actionable failure rather than empty success: %j', async (response, code) => {
    listAccounts.mockResolvedValue(response);
    const result = await socialMediaAccountsTool(siteId).execute({});
    expect(result).toMatchObject({ success: false, error_code: code, error: expect.any(String) });
    expect(result).not.toHaveProperty('data');
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(console.error).toHaveBeenCalledWith('[socialMediaAccountsTool Error]', code);
  });

  it('does not expose client configuration or transport exception details', async () => {
    getOutstandClient.mockImplementation(() => { throw new Error('sensitive configuration'); });
    const result = await socialMediaAccountsTool(siteId).execute({});
    expect(result).toMatchObject({ success: false, error_code: 'ACCOUNT_PROVIDER_ERROR' });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });

  it('fails closed when the trusted site is missing', async () => {
    await expect(socialMediaAccountsTool('').execute({})).resolves.toMatchObject({
      success: false, error_code: 'INVALID_SITE_ID',
    });
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it.each(['http', 'envelope'])('reports billing without leaking provider details or retrying: %s', async (mode) => {
    const secret = randomBytes(32).toString('hex');
    if (mode === 'http') {
      listAccounts.mockRejectedValue(Object.assign(new Error(secret), {
        upstreamStatus: 402, upstreamCode: 'subscription_inactive',
      }));
    } else {
      listAccounts.mockResolvedValue({ success: false, code: 'subscription_inactive', error: secret,
        billingUrl: `https://billing.example.test/${secret}` });
    }
    const result = await socialMediaAccountsTool(siteId).execute({});
    expect(result).toMatchObject({ success: false, error_code: 'ACCOUNT_BILLING_REQUIRED', retryable: false,
      billing_url: 'https://www.outstand.so/app/settings/billing' });
    if (mode === 'http') expect(result).toHaveProperty('upstream_status', 402);
    expect('error' in result && result.error).toContain('Do not retry until billing is resolved');
    expect(result).not.toHaveProperty('data');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(secret);
    expect(console.error).toHaveBeenCalledWith('[socialMediaAccountsTool Error]', 'ACCOUNT_BILLING_REQUIRED',
      expect.objectContaining({ retryable: false }));
    expect(listAccounts).toHaveBeenCalledTimes(1);
  });

  it.each([[401, false], [403, false], [429, true], [503, true]])('retains safe HTTP diagnostics for %i', async (status, retryable) => {
    const secret = randomBytes(32).toString('hex');
    listAccounts.mockRejectedValue(Object.assign(new Error(secret), { upstreamStatus: status }));
    const result = await socialMediaAccountsTool(siteId).execute({});
    expect(result).toMatchObject({ error_code: 'ACCOUNT_PROVIDER_ERROR', upstream_status: status, retryable });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(secret);
  });
});