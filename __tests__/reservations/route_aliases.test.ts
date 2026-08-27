import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/agents/tools/reservations/route';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';
import { assertReservationSlot } from '../../src/lib/reservations/availability';
import { classifyRoundRobinRole, resolveReservationUpdateTarget } from '../../src/lib/reservations/round-robin-assign';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock('../../src/lib/reservations/availability', () => {
  const actual = jest.requireActual('../../src/lib/reservations/availability');
  return {
    ...actual,
    assertReservationSlot: jest.fn().mockImplementation(async (_site: string, _id: string, start: string, end: string) => ({
      start_utc: start,
      end_utc: end,
    })),
  };
});

jest.mock('../../src/lib/services/workflow-robot/dispatch', () => ({
  fireWorkflowDispatch: jest.fn(),
}));

jest.mock('../../src/lib/reservations/family-occupancy', () => ({
  resolveReservationFamily: jest.fn(async (id: string) => ({
    catalogItemId: id,
    rootId: id,
    familyIds: [id],
    mode: 'user_choice',
    siteId: 'site-1',
  })),
}));

jest.mock('../../src/lib/reservations/round-robin-assign', () => ({
  classifyRoundRobinRole: jest.fn(() => 'named'),
  resolveRoundRobinCatalogItem: jest.fn(),
  resolveReservationUpdateTarget: jest.fn(),
}));

describe('Reservations tool route — id aliases', () => {
  const reservationId = 'aa12c67e-693a-43d3-9631-1d7e7a6f0527';
  const leadId = 'f2c35602-0d9d-4bea-92de-83293c08da2d';
  const existing = {
    id: reservationId,
    catalog_item_id: 'cat-1',
    start_time: '2026-08-01T10:00:00Z',
    end_time: '2026-08-01T11:00:00Z',
    quantity: 1,
    catalog_items: { site_id: 'site-1' },
    catalog_item: { name: 'Class', site_id: 'site-1' },
  };

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

  it('updates when reservation_id is sent instead of id', async () => {
    const lookedUpIds: string[] = [];
    let fromCalls = 0;

    (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
      fromCalls += 1;
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockImplementation((_col: string, val: string) => {
          lookedUpIds.push(val);
          return chain;
        }),
        single: jest.fn(),
      };
      if (fromCalls === 1) {
        chain.single.mockResolvedValue({ data: existing, error: null });
      } else {
        chain.single.mockResolvedValue({
          data: { ...existing, status: 'cancelled' },
          error: null,
        });
      }
      return chain;
    });

    const res = await post({
      action: 'update',
      reservation_id: reservationId,
      status: 'cancelled',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.reservation.status).toBe('cancelled');
    expect(lookedUpIds).toContain(reservationId);
  });

  it('rejects update with no mutable fields', async () => {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: existing, error: null }),
    };
    (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);

    const res = await post({
      action: 'update',
      reservation_id: reservationId,
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toContain('No fields to update');
  });

  it('updates lead_id on the reservation', async () => {
    const lookedUpIds: string[] = [];
    let fromCalls = 0;
    let updatePayload: Record<string, unknown> | null = null;

    (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
      fromCalls += 1;
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        update: jest.fn().mockImplementation((payload: Record<string, unknown>) => {
          updatePayload = payload;
          return chain;
        }),
        eq: jest.fn().mockImplementation((_col: string, val: string) => {
          lookedUpIds.push(val);
          return chain;
        }),
        single: jest.fn(),
      };
      if (fromCalls === 1) {
        chain.single.mockResolvedValue({ data: existing, error: null });
      } else {
        chain.single.mockResolvedValue({
          data: { ...existing, lead_id: leadId },
          error: null,
        });
      }
      return chain;
    });

    const res = await post({
      action: 'update',
      reservation_id: reservationId,
      lead_id: leadId,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.reservation.lead_id).toBe(leadId);
    expect(updatePayload).toMatchObject({ lead_id: leadId });
    expect(lookedUpIds).toContain(reservationId);
  });

  it('excludes the current reservation when revalidating capacity on reschedule', async () => {
    let fromCalls = 0;

    (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
      fromCalls += 1;
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn(),
      };
      if (fromCalls === 1) {
        chain.single.mockResolvedValue({ data: existing, error: null });
      } else {
        chain.single.mockResolvedValue({
          data: { ...existing, quantity: 1 },
          error: null,
        });
      }
      return chain;
    });

    const res = await post({
      action: 'update',
      reservation_id: reservationId,
      start_time: existing.start_time,
      end_time: existing.end_time,
      quantity: 1,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(assertReservationSlot).toHaveBeenCalledWith(
      existing.catalog_items.site_id,
      existing.catalog_item_id,
      existing.start_time,
      existing.end_time,
      1,
      true,
      reservationId
    );
  });

  it('rejects quantity below 1 on update', async () => {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: existing, error: null }),
    };
    (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);

    const res = await post({
      action: 'update',
      reservation_id: reservationId,
      start_time: existing.start_time,
      end_time: existing.end_time,
      quantity: 0,
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toContain('quantity must be at least 1');
  });

  it('gets a reservation by reservation_id', async () => {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: existing, error: null }),
    };
    (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);

    const res = await post({
      action: 'get',
      reservation_id: reservationId,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.reservation.id).toBe(reservationId);
    expect(chain.eq).toHaveBeenCalledWith('id', reservationId);
  });

  it('reassigns catalog_item_id onto a named peer', async () => {
    (resolveReservationUpdateTarget as jest.Mock).mockResolvedValue({
      catalog_item_id: 'cesar-corte',
      assigned_from: existing.catalog_item_id,
      peer_root_id: 'cesar',
      role: 'named',
    });
    let updatePayload: Record<string, unknown> | null = null;
    let fromCalls = 0;
    (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
      fromCalls += 1;
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        update: jest.fn().mockImplementation((payload: Record<string, unknown>) => {
          updatePayload = payload;
          return chain;
        }),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn(),
      };
      if (fromCalls === 1) {
        chain.single.mockResolvedValue({ data: existing, error: null });
      } else {
        chain.single.mockResolvedValue({
          data: { ...existing, catalog_item_id: 'cesar-corte' },
          error: null,
        });
      }
      return chain;
    });

    const res = await post({
      action: 'update',
      reservation_id: reservationId,
      catalog_item_id: 'cesar-corte',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.reservation.catalog_item_id).toBe('cesar-corte');
    expect(updatePayload).toMatchObject({ catalog_item_id: 'cesar-corte' });
    expect(assertReservationSlot).toHaveBeenCalledWith(
      existing.catalog_items.site_id,
      'cesar-corte',
      existing.start_time,
      existing.end_time,
      1,
      true,
      reservationId
    );
  });

  it('does not assign a barber when cancelling a round-robin folio', async () => {
    (classifyRoundRobinRole as jest.Mock).mockReturnValueOnce('round_robin_parent');
    let updatePayload: Record<string, unknown> | null = null;
    let fromCalls = 0;
    (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
      fromCalls += 1;
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        update: jest.fn().mockImplementation((payload: Record<string, unknown>) => {
          updatePayload = payload;
          return chain;
        }),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn(),
      };
      if (fromCalls === 1) {
        chain.single.mockResolvedValue({ data: existing, error: null });
      } else {
        chain.single.mockResolvedValue({
          data: { ...existing, status: 'cancelled' },
          error: null,
        });
      }
      return chain;
    });

    const res = await post({
      action: 'update',
      reservation_id: reservationId,
      status: 'cancelled',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.reservation.status).toBe('cancelled');
    expect(resolveReservationUpdateTarget).not.toHaveBeenCalled();
    expect(updatePayload).toMatchObject({ status: 'cancelled' });
    expect(updatePayload?.catalog_item_id).toBeUndefined();
  });
});
