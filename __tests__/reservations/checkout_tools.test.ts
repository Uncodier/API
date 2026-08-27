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

jest.mock('../../src/lib/reservations/round-robin-assign', () => ({
  resolveRoundRobinCatalogItem: jest.fn(async ({ catalogItemId }: { catalogItemId: string }) => ({
    catalog_item_id: catalogItemId,
    assigned_from: catalogItemId,
    peer_root_id: catalogItemId,
    role: 'named',
  })),
}));

describe('Checkout Tool Route Handlers', () => {
  const siteId = 'test-site';
  const userId = 'user-123';
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockSupabaseQuery = (tableName: string, overrides: any = {}) => {
    const chain = {
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: overrides.singleData || {} }),
      maybeSingle: jest.fn().mockResolvedValue({ data: overrides.maybeSingleData || null }),
    };
    
    // Support table-specific overrides
    if (overrides[tableName]) {
      Object.assign(chain, overrides[tableName]);
    }
    
    return chain;
  };

  it('maps reservations to the correct order line regardless of JSON line order', async () => {
    // We mock a checkout with 2 lines: one product, one reservation
    // This tests the P0 bug fix where reservations maps correctly to inserted items
    
    const reqBody = {
      action: 'create_order',
      site_id: siteId,
      customer_email: 'test@example.com',
      lines: [
        { catalogItemId: 'cat-product', quantity: 1 },
        { catalogItemId: 'cat-reservable', quantity: 2, reservationStart: '2026-08-01T10:00:00Z', reservationEnd: '2026-08-01T11:00:00Z' }
      ]
    };
    
    const req = new NextRequest('http://localhost/api', {
      method: 'POST',
      body: JSON.stringify(reqBody)
    });

    let reservationsInserted: any = null;
    let hostInsertCount = 0;

    const catalogById: Record<string, any> = {
      'cat-product': {
        id: 'cat-product',
        name: "Product", status: "active", availability_status: "available",
        target_sale_price: 10,
        site_id: siteId,
        is_reservation: false,
        currency: 'USD',
      },
      'cat-reservable': {
        id: 'cat-reservable',
        name: 'Reservable',
        target_sale_price: 10,
        site_id: siteId,
        is_reservation: true, status: "active", availability_status: "available",
        currency: 'USD',
      },
    };

    (supabaseAdmin.from as jest.Mock).mockImplementation((table) => {
      const chain = mockSupabaseQuery(table);
      
      if (table === 'sites') {
        chain.single.mockResolvedValueOnce({ data: { user_id: userId } });
      } else if (table === 'leads') {
        chain.maybeSingle.mockResolvedValueOnce({ data: null }); // no lead
        chain.single.mockResolvedValueOnce({ data: { id: 'lead-123' } }); // insert lead
      } else if (table === 'catalog_items') {
        let lookupId = '';
        chain.eq = jest.fn().mockImplementation((col: string, val: string) => {
          if (col === 'id') lookupId = val;
          return chain;
        });
        chain.single.mockImplementation(async () => ({
          data: catalogById[lookupId] || {
            id: lookupId,
            name: "Item", status: "active", availability_status: "available",
            target_sale_price: 10,
            site_id: siteId,
            is_reservation: false,
            currency: 'USD',
          },
        }));
      } else if (table === 'sales') {
        chain.single.mockResolvedValueOnce({ data: { id: 'sale-123' } });
      } else if (table === 'sale_orders') {
        chain.single.mockResolvedValueOnce({ data: { id: 'order-123' } });
      } else if (table === 'sale_order_items') {
        // Hosts are inserted one-by-one via .insert().select().single()
        chain.single.mockImplementation(async () => {
          hostInsertCount += 1;
          if (hostInsertCount === 1) {
            return { data: { id: 'soi-prod', catalog_item_id: 'cat-product' } };
          }
          return { data: { id: 'soi-res', catalog_item_id: 'cat-reservable' } };
        });
      } else if (table === 'reservations') {
        chain.insert = jest.fn().mockImplementation((data) => {
          reservationsInserted = data;
          return { select: jest.fn().mockResolvedValue({ data: [] }) };
        });
      }
      
      return chain;
    });

    const res = await POST(req);
    const json = await res.json();
    
    expect(json.success).toBe(true);
    expect(reservationsInserted).not.toBeNull();
    // Only 1 reservation was created
    expect(reservationsInserted).toHaveLength(1);
    // It mapped to the second inserted item correctly
    expect(reservationsInserted[0].sale_order_item_id).toBe('soi-res');
    expect(reservationsInserted[0].quantity).toBe(2);
  });
  
  it('throws an error when passing a string instead of lines array', async () => {
    const reqBody = {
      action: 'create_order',
      site_id: siteId,
      lines: "this should be parsed by protocol, but the route expects an array"
    };
    
    const req = new NextRequest('http://localhost/api', {
      method: 'POST',
      body: JSON.stringify(reqBody)
    });
    
    const res = await POST(req);
    const json = await res.json();
    
    expect(json.success).toBe(false);
    expect(json.error).toBe('lines must be a non-empty array');
  });
  
  it('supports create_order_from_quotation bridge action', async () => {
    const reqBody = {
      action: 'create_order_from_quotation',
      site_id: siteId,
      quotation_id: 'quote-123'
    };
    
    const req = new NextRequest('http://localhost/api', {
      method: 'POST',
      body: JSON.stringify(reqBody)
    });

    (supabaseAdmin.from as jest.Mock).mockImplementation((table) => {
      const chain = mockSupabaseQuery(table);
      
      if (table === 'quotations') {
        chain.single.mockResolvedValueOnce({ 
          data: { 
            id: 'quote-123', 
            status: 'sent', 
            lead_id: 'lead-123',
            items: [{ catalog_item_id: 'cat-1', quantity: 2, unit_price: 15 }]
          } 
        });
      } else if (table === 'sites') {
        chain.single.mockResolvedValueOnce({ data: { user_id: userId } });
      } else if (table === 'catalog_items') {
        chain.single.mockResolvedValueOnce({ data: { name: "Item", status: "active", availability_status: "available", target_sale_price: 10, site_id: siteId, currency: 'MXN' } });
      } else if (table === 'sales' || table === 'sale_orders') {
        chain.single.mockResolvedValueOnce({ data: { id: 'obj-123' } });
      } else if (table === 'sale_order_items') {
        chain.single.mockResolvedValueOnce({ data: { id: 'soi-1', catalog_item_id: 'cat-1' } });
      }
      
      return chain;
    });

    const res = await POST(req);
    const json = await res.json();
    
    expect(json.success).toBe(true);
    // Verified it didn't throw
  });
  
  it('fails create_order_from_quotation if quotation is draft', async () => {
    const reqBody = {
      action: 'create_order_from_quotation',
      site_id: siteId,
      quotation_id: 'quote-123'
    };
    
    const req = new NextRequest('http://localhost/api', {
      method: 'POST',
      body: JSON.stringify(reqBody)
    });

    (supabaseAdmin.from as jest.Mock).mockImplementation((table) => {
      const chain = mockSupabaseQuery(table);
      if (table === 'quotations') {
        chain.single.mockResolvedValueOnce({ data: { status: 'draft' } });
      }
      return chain;
    });

    const res = await POST(req);
    const json = await res.json();
    
    expect(json.success).toBe(false);
    expect(json.error).toContain('Cannot convert quotation with status: draft');
  });
});
