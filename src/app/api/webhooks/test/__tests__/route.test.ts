import { NextRequest } from 'next/server';
import { POST } from '../route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { canAccessSite } from '@/lib/security/site-access';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));
jest.mock('@/lib/security/safe-remote-url', () => ({
  assertSafeRemoteUrl: jest.fn(),
}));
jest.mock('@/lib/security/site-access', () => ({
  canAccessSite: jest.fn(),
}));

const mockFrom = supabaseAdmin.from as jest.Mock;
const mockAssertSafeRemoteUrl = assertSafeRemoteUrl as jest.Mock;
const mockCanAccessSite = canAccessSite as jest.Mock;
const mockFetch = jest.fn();

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/webhooks/test', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function mockEndpointQuery() {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({
    data: {
      id: 'endpoint-1',
      site_id: 'site-1',
      target_url: 'https://hooks.example.com/events',
      secret: 'signing-secret',
    },
    error: null,
  });
  mockFrom.mockReturnValue(query);
}

describe('POST /api/webhooks/test', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
    mockCanAccessSite.mockResolvedValue(true);
    mockAssertSafeRemoteUrl.mockResolvedValue(new URL('https://hooks.example.com/events'));
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    mockEndpointQuery();
  });

  it('sends the selected record with the canonical event name', async () => {
    const selectedRecord = {
      id: 'deal-1',
      site_id: 'site-1',
      name: 'Enterprise renewal',
    };

    const response = await POST(request({
      endpoint_id: 'endpoint-1',
      site_id: 'site-1',
      operation: 'DELETE',
      table: 'deals',
      record: selectedRecord,
    }));

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({
      type: 'deal.deleted',
      site_id: 'site-1',
      table: 'deals',
      object_id: 'deal-1',
      data: selectedRecord,
      test: true,
    });
    expect(init.headers).toEqual(expect.objectContaining({
      'X-Webhook-Event': 'deal.deleted',
      'X-Webhook-Test': 'true',
      'X-Webhook-Signature': expect.any(String),
    }));
  });

  it('requires a selected record for update and delete tests', async () => {
    const response = await POST(request({
      endpoint_id: 'endpoint-1',
      site_id: 'site-1',
      operation: 'UPDATE',
      table: 'deals',
    }));

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects users without access to the requested site', async () => {
    mockCanAccessSite.mockResolvedValue(false);

    const response = await POST(request({
      endpoint_id: 'endpoint-1',
      site_id: 'site-1',
      operation: 'INSERT',
      table: 'deals',
    }));

    expect(response.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
