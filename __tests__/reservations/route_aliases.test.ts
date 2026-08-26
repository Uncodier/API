import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/agents/tools/reservations/route';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

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

  it('rejects update with only lead_id (no mutable fields)', async () => {
    const res = await post({
      action: 'update',
      reservation_id: reservationId,
      lead_id: leadId,
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toContain('No fields to update');
    expect(json.error).toContain('lead_id is create-only');
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
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
});
