import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/agents/tools/reservations/route';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';
import { fireWorkflowDispatch } from '../../src/lib/services/workflow-robot/dispatch';
import { resolveRoundRobinCatalogItem } from '../../src/lib/reservations/round-robin-assign';

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
  getAvailableSlots: jest.fn(),
  ReservableCatalogItemError: class ReservableCatalogItemError extends Error {
    statusCode = 400;
  },
}));

jest.mock('../../src/lib/services/workflow-robot/dispatch', () => ({
  fireWorkflowDispatch: jest.fn(),
}));

jest.mock('../../src/lib/reservations/round-robin-assign', () => ({
  classifyRoundRobinRole: jest.fn(() => 'named'),
  resolveRoundRobinCatalogItem: jest.fn(async ({ catalogItemId }: { catalogItemId: string }) => ({
    catalog_item_id: catalogItemId,
    assigned_from: catalogItemId,
    peer_root_id: catalogItemId,
    role: 'named',
  })),
  resolveReservationUpdateTarget: jest.fn(),
}));

jest.mock('../../src/lib/reservations/pass-redemption', () => ({
  resolveReservationEntitlement: jest.fn(
    async ({ requestedEntitlementId }: { requestedEntitlementId?: string | null }) =>
      requestedEntitlementId || null
  ),
  catalogItemCoveredByPass: jest.fn(),
}));

describe('reservations.create creates a sale_order', () => {
  const siteId = 'site-1';
  const leadId = 'lead-1';
  const catalogItemId = 'cat-reservable';
  const start = '2026-08-01T10:00:00Z';
  const end = '2026-08-01T11:00:00Z';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const post = (body: Record<string, unknown>) =>
    POST(
      new NextRequest('http://localhost/api/agents/tools/reservations', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    );

  function mockCommerceTables(opts: {
    catalogPrice: number;
    catalogCurrency?: string | null;
    siteCurrency?: string;
    entitlement?: { id: string; passCatalogItemId: string };
    promotions?: Record<string, unknown>[];
    capture: {
      sale?: Record<string, unknown>;
      order?: Record<string, unknown>;
      orderItem?: Record<string, unknown>;
      reservations?: Record<string, unknown>[];
    };
  }) {
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        single: jest.fn().mockResolvedValue({ data: {}, error: null }),
      };

      if (table === 'entitlements') {
        chain.single.mockResolvedValue({
          data: opts.entitlement
            ? {
                id: opts.entitlement.id,
                status: 'active',
                uses_remaining: 3,
                catalog_item_id: opts.entitlement.passCatalogItemId,
              }
            : null,
          error: opts.entitlement ? null : { message: 'not found' },
        });
      } else if (table === 'pass_redeemable_items') {
        chain.maybeSingle.mockResolvedValue({
          data: opts.entitlement ? { id: 'pri-1' } : null,
          error: null,
        });
      } else if (table === 'sites') {
        chain.single.mockResolvedValue({ data: { user_id: 'user-1' }, error: null });
      } else if (table === 'promotions') {
        const result = { data: opts.promotions ?? [], error: null };
        chain.then = (onFulfilled: unknown, onRejected?: unknown) =>
          Promise.resolve(result).then(
            onFulfilled as (value: unknown) => unknown,
            onRejected as (reason: unknown) => unknown
          );
      } else if (table === 'settings') {
        chain.maybeSingle.mockResolvedValue({
          data: { currency: opts.siteCurrency || 'USD' },
          error: null,
        });
      } else if (table === 'catalog_items') {
        chain.single.mockResolvedValue({
          data: {
            id: catalogItemId,
            name: "Haircut", status: "active", availability_status: "available",
            description: null,
            target_sale_price: opts.catalogPrice,
            site_id: siteId,
            is_reservation: true, status: "active", availability_status: "available",
            currency: opts.catalogCurrency === undefined ? 'USD' : opts.catalogCurrency,
          },
          error: null,
        });
      } else if (table === 'sales') {
        chain.insert = jest.fn().mockImplementation((payload: Record<string, unknown>) => {
          opts.capture.sale = payload;
          return chain;
        });
        chain.single.mockResolvedValue({ data: { id: 'sale-1', status: 'pending' }, error: null });
      } else if (table === 'sale_orders') {
        chain.insert = jest.fn().mockImplementation((payload: Record<string, unknown>) => {
          opts.capture.order = payload;
          return chain;
        });
        chain.single.mockResolvedValue({ data: { id: 'order-1', status: 'pending' }, error: null });
      } else if (table === 'sale_order_items') {
        chain.insert = jest.fn().mockImplementation((payload: Record<string, unknown>) => {
          opts.capture.orderItem = payload;
          return chain;
        });
        chain.single.mockResolvedValue({
          data: { id: 'soi-res', catalog_item_id: catalogItemId },
          error: null,
        });
      } else if (table === 'reservations') {
        chain.insert = jest.fn().mockImplementation((data: Record<string, unknown>[]) => {
          opts.capture.reservations = data;
          return {
            select: jest.fn().mockResolvedValue({
              data: data.map((row) => ({ id: 'res-1', ...row })),
              error: null,
            }),
          };
        });
      }

      return chain;
    });
  }

  it('inserts sales, sale_orders, sale_order_items, and a reservation linked to the line', async () => {
    const capture: {
      sale?: Record<string, unknown>;
      order?: Record<string, unknown>;
      orderItem?: Record<string, unknown>;
      reservations?: Record<string, unknown>[];
    } = {};
    mockCommerceTables({ catalogPrice: 25, catalogCurrency: 'MXN', siteCurrency: 'USD', capture });

    const res = await post({
      action: 'create',
      site_id: siteId,
      catalog_item_id: catalogItemId,
      lead_id: leadId,
      start_time: start,
      end_time: end,
      quantity: 1,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.order_id).toBe('order-1');
    expect(json.sale_id).toBe('sale-1');
    expect(json.reservation.id).toBe('res-1');
    expect(json.reservation.sale_order_item_id).toBe('soi-res');

    expect(capture.sale).toMatchObject({
      site_id: siteId,
      lead_id: leadId,
      amount: 25,
      status: 'pending',
      currency: 'MXN',
    });
    expect(capture.order).toMatchObject({
      sale_id: 'sale-1',
      site_id: siteId,
      total: 25,
      status: 'pending',
      currency: 'MXN',
    });
    expect(capture.order?.items).toEqual([
      expect.objectContaining({ id: catalogItemId, unitPrice: 25, currency: 'MXN' }),
    ]);
    expect(capture.orderItem).toMatchObject({
      catalog_item_id: catalogItemId,
      unit_price: 25,
      quantity: 1,
      sale_order_id: 'order-1',
      metadata: { currency: 'MXN' },
    });
    expect(capture.reservations).toHaveLength(1);
    expect(capture.reservations?.[0]).toMatchObject({
      catalog_item_id: catalogItemId,
      sale_order_item_id: 'soi-res',
      lead_id: leadId,
      quantity: 1,
      start_time: start,
      end_time: end,
    });
    expect(fireWorkflowDispatch).toHaveBeenCalledWith({
      table: 'reservations',
      op: 'insert',
      row: expect.objectContaining({ id: 'res-1' }),
      site_id: siteId,
    });
  });

  it('redeems a pass at unit_price 0 and keeps entitlement_id on the reservation', async () => {
    const capture: {
      sale?: Record<string, unknown>;
      order?: Record<string, unknown>;
      orderItem?: Record<string, unknown>;
      reservations?: Record<string, unknown>[];
    } = {};
    mockCommerceTables({
      catalogPrice: 25,
      entitlement: { id: 'ent-1', passCatalogItemId: 'cat-pass' },
      capture,
    });

    const res = await post({
      action: 'create',
      site_id: siteId,
      catalog_item_id: catalogItemId,
      lead_id: leadId,
      start_time: start,
      end_time: end,
      entitlement_id: 'ent-1',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.order_id).toBe('order-1');
    expect(json.reservation.entitlement_id).toBe('ent-1');
    expect(capture.orderItem).toMatchObject({ unit_price: 0, subtotal: 0 });
    expect(capture.sale).toMatchObject({ amount: 0 });
    expect(capture.reservations?.[0]).toMatchObject({
      entitlement_id: 'ent-1',
      sale_order_item_id: 'soi-res',
    });
  });

  it('falls back to site currency when the catalog item has none', async () => {
    const capture: {
      sale?: Record<string, unknown>;
      order?: Record<string, unknown>;
      orderItem?: Record<string, unknown>;
      reservations?: Record<string, unknown>[];
    } = {};
    mockCommerceTables({
      catalogPrice: 25,
      catalogCurrency: null,
      siteCurrency: 'MXN',
      capture,
    });

    const res = await post({
      action: 'create',
      site_id: siteId,
      catalog_item_id: catalogItemId,
      lead_id: leadId,
      start_time: start,
      end_time: end,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(capture.sale).toMatchObject({ currency: 'MXN' });
    expect(capture.order).toMatchObject({ currency: 'MXN' });
    expect(capture.orderItem).toMatchObject({ metadata: { currency: 'MXN' } });
  });

  it('stores the assigned named catalog item from round-robin resolve', async () => {
    const assignedId = 'cesar-corte';
    (resolveRoundRobinCatalogItem as jest.Mock).mockResolvedValueOnce({
      catalog_item_id: assignedId,
      assigned_from: catalogItemId,
      peer_root_id: 'cesar',
      role: 'round_robin_parent',
    });
    const capture: {
      sale?: Record<string, unknown>;
      order?: Record<string, unknown>;
      orderItem?: Record<string, unknown>;
      reservations?: Record<string, unknown>[];
    } = {};
    mockCommerceTables({ catalogPrice: 25, capture });

    const res = await post({
      action: 'create',
      site_id: siteId,
      catalog_item_id: catalogItemId,
      lead_id: leadId,
      start_time: start,
      end_time: end,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.assignment.catalog_item_id).toBe(assignedId);
    expect(capture.reservations?.[0]).toMatchObject({ catalog_item_id: assignedId });
    expect(capture.orderItem).toMatchObject({ catalog_item_id: assignedId });
  });

  it('applies the best compatible promotion and returns it for the agent to relay', async () => {
    const capture: {
      sale?: Record<string, unknown>;
      order?: Record<string, unknown>;
      orderItem?: Record<string, unknown>;
      reservations?: Record<string, unknown>[];
    } = {};
    mockCommerceTables({
      catalogPrice: 25,
      catalogCurrency: 'MXN',
      capture,
      promotions: [
        {
          id: 'promo-20',
          name: '20% off',
          discount_type: 'percent',
          discount_value: 20,
          applies_to: 'all',
        },
      ],
    });

    const res = await post({
      action: 'create',
      site_id: siteId,
      catalog_item_id: catalogItemId,
      lead_id: leadId,
      start_time: start,
      end_time: end,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.subtotal).toBe(25);
    expect(json.discount_total).toBe(5);
    expect(json.total).toBe(20);
    expect(json.applied_promotions).toEqual([
      expect.objectContaining({ id: 'promo-20', name: '20% off', discount_amount: 5 }),
    ]);
    expect(json.notification).toContain('20% off');
    expect(json.notification).toContain('Tell the customer this discounted total');
    expect(capture.sale).toMatchObject({ amount: 25, amount_due: 20 });
    expect(capture.order).toMatchObject({ subtotal: 25, discount_total: 5, total: 20 });
  });
});
