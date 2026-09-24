import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { OutstandClient } from '../client';

const mockCanAccessSite = jest.fn();
const mockGetRequestSitePrincipal = jest.fn();

jest.mock('@/lib/security/site-access', () => ({
  canAccessSite: mockCanAccessSite,
  getRequestSitePrincipal: mockGetRequestSitePrincipal,
}));

import {
  authorizeOutstandConversation,
  listAuthorizedOutstandConversations,
  requireOutstandConversationSite,
} from '../conversation-access';

const SITE_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_SITE_ID = '00000000-0000-4000-8000-000000000002';

function clientWith(overrides: Record<string, unknown> = {}) {
  return {
    listAccounts: jest.fn().mockResolvedValue({
      success: true,
      data: [{ id: 'account-1', tenant_id: SITE_ID }],
      total: 1,
    } as never),
    getConversation: jest.fn().mockResolvedValue({
      success: true,
      conversation: {
        id: 'conversation-1',
        socialAccountId: 'account-1',
      },
    } as never),
    listConversations: jest.fn().mockResolvedValue({
      success: true,
      data: [
        { id: 'conversation-1', socialAccountId: 'account-1' },
        { id: 'conversation-2', socialAccountId: 'account-2' },
      ],
      pagination: { hasMore: false, nextCursor: null, limit: 25 },
    } as never),
    ...overrides,
  } as unknown as OutstandClient;
}

describe('Outstand conversation tenant access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanAccessSite.mockResolvedValue(true as never);
    mockGetRequestSitePrincipal.mockReturnValue({
      internal: false,
      userId: 'user-1',
      siteId: null,
    });
  });

  it('requires an authorized site for a conversation request', async () => {
    const request = new Request(
      `https://api.example.com/api/integrations/outstand/conversations?tenant_id=${SITE_ID}`,
    );

    await expect(requireOutstandConversationSite(request)).resolves.toBe(SITE_ID);
    expect(mockCanAccessSite).toHaveBeenCalledWith(request, SITE_ID);
  });

  it('rejects a tenant that differs from a site-bound API key', async () => {
    mockGetRequestSitePrincipal.mockReturnValue({
      internal: false,
      userId: 'user-1',
      siteId: SITE_ID,
    });

    await expect(requireOutstandConversationSite(new Request(
      `https://api.example.com/api/integrations/outstand/conversations?tenant_id=${OTHER_SITE_ID}`,
    ))).rejects.toMatchObject({ status: 403 });
    expect(mockCanAccessSite).not.toHaveBeenCalled();
  });

  it('rejects a conversation owned by another tenant account', async () => {
    const client = clientWith({
      getConversation: jest.fn().mockResolvedValue({
        success: true,
        conversation: {
          id: 'conversation-2',
          socialAccountId: 'account-2',
        },
      } as never),
    });

    await expect(authorizeOutstandConversation(
      client,
      'conversation-2',
      SITE_ID,
    )).rejects.toMatchObject({ status: 404 });
  });

  it('filters unscoped provider results to the tenant account set', async () => {
    const result = await listAuthorizedOutstandConversations(
      clientWith(),
      { limit: 25 },
      SITE_ID,
    );

    expect(result.data).toEqual([
      expect.objectContaining({ id: 'conversation-1' }),
    ]);
  });
});
