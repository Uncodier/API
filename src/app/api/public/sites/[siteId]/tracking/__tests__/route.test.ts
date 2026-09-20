import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const from: any = jest.fn();
const mockOriginBelongsToSite: any = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from },
}));
jest.mock('@/lib/security/site-access', () => ({
  originBelongsToSite: mockOriginBelongsToSite,
}));

import { GET } from '../route';

const siteId = '33333333-3333-4333-8333-333333333333';

function singleResult(data: unknown, error: unknown = null) {
  const maybeSingle = (jest.fn() as any).mockResolvedValue({ data, error });
  const eq = jest.fn(() => ({ maybeSingle }));
  return { select: jest.fn(() => ({ eq })) };
}

describe('public site tracking configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOriginBelongsToSite.mockResolvedValue(true);
  });

  it('returns only normalized public settings', async () => {
    from
      .mockReturnValueOnce(singleResult({
        id: siteId,
        url: 'https://example.com',
        tracking: {
          track_visitors: true,
          enable_chat: true,
          privacy: { cookie_consent: true },
        },
      }))
      .mockReturnValueOnce(singleResult({
        channels: {
          website: {
            enable_chat: false,
            chat_title: 'Website support',
            show_cookie_consent: false,
          },
        },
      }));

    const response = await GET(
      new Request(`http://localhost/api/public/sites/${siteId}/tracking`, {
        headers: { origin: 'https://example.com' },
      }) as never,
      { params: Promise.resolve({ siteId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        site_id: siteId,
        track_visitors: true,
        track_actions: false,
        record_screen: false,
        chat: {
          enabled: false,
          accent_color: null,
          position: 'bottom-right',
          title: 'Website support',
          welcome_message: null,
          allow_anonymous_messages: false,
        },
        cookie_consent: false,
      },
    });
  });

  it('rejects a mismatched browser origin', async () => {
    mockOriginBelongsToSite.mockResolvedValue(false);
    from
      .mockReturnValueOnce(singleResult({
        id: siteId,
        url: 'https://example.com',
        tracking: {},
      }))
      .mockReturnValueOnce({
        select: jest.fn(() => ({
          eq: (jest.fn() as any).mockResolvedValue({ data: [], error: null }),
        })),
      });

    const response = await GET(
      new Request(`http://localhost/api/public/sites/${siteId}/tracking`, {
        headers: { origin: 'https://attacker.example' },
      }) as never,
      { params: Promise.resolve({ siteId }) },
    );

    expect(response.status).toBe(403);
    expect(from).not.toHaveBeenCalledWith('settings');
  });

  it('rejects invalid site identifiers before querying', async () => {
    const response = await GET(
      new Request('http://localhost/api/public/sites/not-a-uuid/tracking') as never,
      { params: Promise.resolve({ siteId: 'not-a-uuid' }) },
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});
