import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetOutstandClient = jest.fn();
const mockRequireSite = jest.fn();
const mockFrom = jest.fn();
jest.unstable_mockModule('@/lib/integrations/outstand/client', () => ({ getOutstandClient: mockGetOutstandClient }));
jest.unstable_mockModule('@/lib/integrations/outstand/conversation-access', () => ({ requireOutstandConversationSite: mockRequireSite }));
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: mockFrom } }));

const SITE_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_SITE_ID = '00000000-0000-4000-8000-000000000002';
const owned = { id: 'yTdoj', network: 'tiktok', isActive: true };
const importSocialAccountPosts = jest.fn();
const listAccounts = jest.fn();
const listSocialAccountImports = jest.fn();
const mockNot = jest.fn();
const mockSelect = jest.fn(() => ({ not: mockNot }));
const URL = `http://localhost/api/integrations/outstand/social-accounts/yTdoj/imports?tenant_id=${SITE_ID}`;
const request = (body: unknown) => new Request(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const getRequest = () => new Request(URL);
const context = { params: Promise.resolve({ id: owned.id }) };

describe('Outstand social account history import', () => {
  let POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  let GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  beforeEach(async () => {
    jest.clearAllMocks();
    ({ POST, GET } = await import('../route'));
    mockRequireSite.mockResolvedValue(SITE_ID as never);
    mockFrom.mockReturnValue({ select: mockSelect });
    mockNot.mockResolvedValue({ data: [{ site_id: SITE_ID, social_media: [owned] }], error: null } as never);
    listAccounts.mockResolvedValue({ data: [owned] } as never);
    importSocialAccountPosts.mockResolvedValue({ success: true, data: { id: 'import-1', status: 'queued' } } as never);
    listSocialAccountImports.mockResolvedValue({ success: true, data: [], count: 0 } as never);
    mockGetOutstandClient.mockReturnValue({ listAccounts, importSocialAccountPosts, listSocialAccountImports });
  });

  it('imports only an active account uniquely owned by the authorized site', async () => {
    const response = await POST(request({ confirm: true, limit: 10 }), context);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ success: true, data: { id: 'import-1', status: 'queued' } });
    expect(listAccounts).toHaveBeenCalledWith(SITE_ID, { tenantId: SITE_ID, limit: 100 });
    expect(importSocialAccountPosts).toHaveBeenCalledWith(owned.id, SITE_ID, { limit: 10 });
  });

  it('requires explicit confirmation and a bounded limit before billing', async () => {
    for (const body of [{}, { limit: 10 }, { confirm: true }, { confirm: true, limit: 101 }, { confirm: true, limit: 1, since: 'yesterday' }]) {
      expect((await POST(request(body), context)).status).toBe(400);
    }
    expect(importSocialAccountPosts).not.toHaveBeenCalled();
  });

  it('lists existing jobs using the authorized account and site', async () => {
    listSocialAccountImports.mockResolvedValueOnce({
      success: true, data: [{ id: 'job-1', status: 'running', imported: 0, failed: 0 }], count: 1,
    } as never);
    const response = await GET(getRequest(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [{ id: 'job-1', status: 'running' }] });
    expect(listSocialAccountImports).toHaveBeenCalledWith(owned.id, SITE_ID);
    expect(importSocialAccountPosts).not.toHaveBeenCalled();
  });

  it('will not enqueue a duplicate billable import job', async () => {
    listSocialAccountImports.mockResolvedValueOnce({
      success: true, data: [{ id: 'job-1', status: 'failed', imported: 0, failed: 1 }], count: 1,
    } as never);
    expect((await POST(request({ confirm: true, limit: 10 }), context)).status).toBe(409);
    expect(importSocialAccountPosts).not.toHaveBeenCalled();
  });

  it('denies an unauthorized tenant before reading accounts', async () => {
    mockRequireSite.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }) as never);
    expect((await POST(request({ confirm: true, limit: 10 }), context)).status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(importSocialAccountPosts).not.toHaveBeenCalled();
  });

  it('denies an account bound to a different or multiple sites', async () => {
    for (const settings of [
      [{ site_id: OTHER_SITE_ID, social_media: [owned] }],
      [{ site_id: SITE_ID, social_media: [owned] }, { site_id: OTHER_SITE_ID, social_media: [owned] }],
    ]) {
      mockNot.mockResolvedValueOnce({ data: settings, error: null } as never);
      expect((await POST(request({ confirm: true, limit: 10 }), context)).status).toBe(403);
    }
    expect(importSocialAccountPosts).not.toHaveBeenCalled();
  });

  it('rejects accounts that the provider binds to another tenant', async () => {
    listAccounts.mockResolvedValueOnce({ data: [{ ...owned, tenant_id: OTHER_SITE_ID }] } as never);
    expect((await POST(request({ confirm: true, limit: 10 }), context)).status).toBe(404);
    expect(importSocialAccountPosts).not.toHaveBeenCalled();
  });

  it('rejects inactive, missing, or mismatched provider accounts', async () => {
    for (const accounts of [[{ ...owned, isActive: false }], [], [{ ...owned, network: 'instagram' }]]) {
      listAccounts.mockResolvedValueOnce({ data: accounts } as never);
      expect((await POST(request({ confirm: true, limit: 10 }), context)).status).toBe(404);
    }
    expect(importSocialAccountPosts).not.toHaveBeenCalled();
  });

  it('fails closed on a settings query error', async () => {
    mockNot.mockResolvedValueOnce({ data: null, error: { message: 'Database unavailable' } } as never);
    expect((await POST(request({ confirm: true, limit: 10 }), context)).status).toBe(500);
    expect(importSocialAccountPosts).not.toHaveBeenCalled();
  });
});
