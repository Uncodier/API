import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/agents/tools/catalog_commerce/route';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('catalog_commerce create action', () => {
  const siteId = 'site-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockInsert(result: { data?: unknown; error?: { message: string } | null }) {
    const chain = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: result.data ?? null,
        error: result.error ?? null,
      }),
      eq: jest.fn().mockReturnThis(),
      head: true,
    };
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'reservation_schedules') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockResolvedValue({ count: 0 }),
        };
      }
      return chain;
    });
    return chain;
  }

  it('creates a catalog item with defaults', async () => {
    const created = {
      id: 'cat-1',
      site_id: siteId,
      name: 'Cold Brew',
      kind: 'product',
      target_sale_price: 45,
      is_purchasable: true,
      status: 'active',
      availability_status: 'available',
    };
    const chain = mockInsert({ data: created });

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        site_id: siteId,
        name: 'Cold Brew',
        target_sale_price: 45,
        currency: 'MXN',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.item.name).toBe('Cold Brew');
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        site_id: siteId,
        name: 'Cold Brew',
        kind: 'product',
        status: 'active',
        availability_status: 'available',
        is_purchasable: true,
        target_sale_price: 45,
        currency: 'MXN',
      })
    );
  });

  it('rejects create without name', async () => {
    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        site_id: siteId,
        target_sale_price: 10,
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/name/i);
  });

  it('rejects create without site_id', async () => {
    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        name: 'Latte',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/site_id/i);
  });
});
