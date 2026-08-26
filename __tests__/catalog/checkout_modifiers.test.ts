import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/agents/tools/checkout/route';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock('../../src/lib/reservations/availability', () => ({
  assertReservationSlot: jest.fn().mockImplementation(async (_site, _id, start, end) => ({
    start_utc: start,
    end_utc: end,
  })),
}));

describe('checkout nested modifiers', () => {
  const siteId = 'site-mod';
  const userId = 'user-mod';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('inserts host + child sale_order_items and includes modifiers in subtotal', async () => {
    const hostInserts: any[] = [];
    const childInserts: any[] = [];
    let salePayload: any = null;

    const req = new NextRequest('http://localhost/api', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create_order',
        site_id: siteId,
        customer_email: 'buyer@example.com',
        lines: [
          {
            catalogItemId: 'cat-host',
            quantity: 1,
            modifiers: [{ catalogItemId: 'cat-mod', quantity: 2 }],
          },
        ],
      }),
    });

    const catalogById: Record<string, any> = {
      'cat-host': {
        id: 'cat-host',
        name: 'Cold Brew',
        description: null,
        target_sale_price: 45,
        site_id: siteId,
        is_reservation: false,
        currency: 'MXN',
      },
      'cat-mod': {
        id: 'cat-mod',
        name: 'Oat milk',
        description: null,
        target_sale_price: 10,
        site_id: siteId,
        is_reservation: false,
        currency: 'MXN',
      },
    };

    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null }),
        single: jest.fn().mockResolvedValue({ data: {} }),
      };

      if (table === 'sites') {
        chain.single.mockResolvedValue({ data: { user_id: userId } });
      } else if (table === 'leads') {
        chain.maybeSingle.mockResolvedValue({ data: null });
        chain.single.mockResolvedValue({ data: { id: 'lead-1' } });
      } else if (table === 'catalog_items') {
        let lookupId = '';
        chain.eq.mockImplementation((col: string, val: string) => {
          if (col === 'id') lookupId = val;
          return chain;
        });
        chain.single.mockImplementation(async () => ({
          data: catalogById[lookupId] || null,
          error: catalogById[lookupId] ? null : { message: 'not found' },
        }));
      } else if (table === 'catalog_item_modifier_groups') {
        // No attachments configured → allow explicit modifiers
        const end = {
          ...chain,
          eq: jest.fn().mockResolvedValue({ data: [], error: null }),
        };
        chain.eq.mockReturnValue(end);
      } else if (table === 'sales') {
        chain.insert.mockImplementation((payload: any) => {
          salePayload = payload;
          return chain;
        });
        chain.single.mockResolvedValue({ data: { id: 'sale-1' } });
      } else if (table === 'sale_orders') {
        chain.single.mockResolvedValue({ data: { id: 'order-1', status: 'pending' } });
      } else if (table === 'sale_order_items') {
        chain.insert.mockImplementation((payload: any) => {
          if (Array.isArray(payload)) {
            childInserts.push(...payload);
            return { error: null };
          }
          hostInserts.push(payload);
          return chain;
        });
        chain.single.mockResolvedValue({
          data: { id: 'soi-host', catalog_item_id: 'cat-host' },
        });
      }

      return chain;
    });

    const res = await POST(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(salePayload.amount).toBe(65); // 45 + 10*2
    expect(hostInserts).toHaveLength(1);
    expect(hostInserts[0].catalog_item_id).toBe('cat-host');
    expect(hostInserts[0].parent_sale_order_item_id).toBeNull();
    expect(childInserts).toHaveLength(1);
    expect(childInserts[0].catalog_item_id).toBe('cat-mod');
    expect(childInserts[0].parent_sale_order_item_id).toBe('soi-host');
    expect(childInserts[0].quantity).toBe(2);
    expect(childInserts[0].subtotal).toBe(20);
  });
});
