import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getAvailableSlots, assertReservationSlot, ReservableCatalogItemError } from '@/lib/reservations/availability';
import { createSaleOrderFromLines, discountFieldsForToolResult } from '@/app/api/agents/tools/checkout/create-order';
import { buildWriteIdempotencyKey } from '@/lib/agentbase/utils/write-idempotency';
import {
  classifyRoundRobinRole,
  resolveReservationUpdateTarget,
  resolveRoundRobinCatalogItem,
} from '@/lib/reservations/round-robin-assign';
import { resolveReservationEntitlement } from '@/lib/reservations/pass-redemption';
import { resolveReservationFamily } from '@/lib/reservations/family-occupancy';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      action,
      id,
      reservation_id,
      catalog_item_id,
      lead_id,
      site_id,
      limit = 50,
      offset = 0,
      entitlement_id,
      buyer_user_id,
      owner_site_id,
      command_id,
      ...updates
    } = body;
    const reservationId = id || reservation_id;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

        if (action === 'get_available_slots') {
      const { from_date, to_date, quantity = 1 } = updates;
      if (!catalog_item_id || !from_date || !to_date) {
        throw new ReservableCatalogItemError(
          'Missing required fields for get_available_slots: catalog_item_id, from_date, to_date'
        );
      }

      const availability = await getAvailableSlots(catalog_item_id, from_date, to_date, quantity);
      return NextResponse.json({
        success: true,
        ...availability,
      });
    }

    if (action === 'create') {
      if (!site_id) throw new Error('Missing site_id');
      if (!catalog_item_id) throw new Error('Missing catalog_item_id');
      if (!lead_id) throw new Error('Missing lead_id');
      if (!updates.start_time || !updates.end_time) throw new Error('Missing start/end times');

      const quantity = updates.quantity ?? 1;
      const idempotency_key = command_id
        ? buildWriteIdempotencyKey(String(command_id), 'reservations', 'create', {
            catalog_item_id,
            lead_id,
            start_time: updates.start_time,
            end_time: updates.end_time,
            quantity,
            entitlement_id: entitlement_id || null,
            site_id,
          })
        : null;

      if (idempotency_key) {
        const { findExistingCreatedOrder } = await import('@/app/api/agents/tools/checkout/order-idempotency');
        const existing = await findExistingCreatedOrder(idempotency_key);
        if (existing?.reservations?.[0]) {
          return NextResponse.json({
            success: true,
            reservation: existing.reservations[0],
            assignment: {
              catalog_item_id: existing.reservations[0].catalog_item_id,
              source: 'idempotent_replay',
            },
            order_id: existing.order.id,
            sale_id: existing.sale.id,
            ...discountFieldsForToolResult(existing),
          });
        }
      }

      const assignment = await resolveRoundRobinCatalogItem({
        catalogItemId: catalog_item_id,
        start: updates.start_time,
        end: updates.end_time,
        quantity,
      });
      const resolvedCatalogItemId = assignment.catalog_item_id;
      const resolvedEntitlementId = await resolveReservationEntitlement({
        siteId: site_id,
        leadId: lead_id,
        quantity,
        catalogItemId: resolvedCatalogItemId,
        originalCatalogItemId: catalog_item_id,
        requestedEntitlementId: entitlement_id,
      });

      const result = await createSaleOrderFromLines({
        site_id,
        lead_id,
        buyer_user_id,
        owner_site_id,
        lines: [
          {
            catalogItemId: resolvedCatalogItemId,
            quantity,
            reservationStart: updates.start_time,
            reservationEnd: updates.end_time,
            ...(resolvedEntitlementId ? { unitPriceOverride: 0 } : {}),
          },
        ],
        reservationExtras: {
          entitlement_id: resolvedEntitlementId,
          status: updates.status || 'pending',
          notes: updates.notes || null,
        },
        command_id: command_id || null,
        idempotency_key,
      });

      const reservation = result.reservations[0];
      if (!reservation) {
        throw new Error('Failed to create capacity reservation for order');
      }

      const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
      fireWorkflowDispatch({ table: 'reservations', op: 'insert', row: reservation, site_id });

      return NextResponse.json({
        success: true,
        reservation,
        assignment,
        order_id: result.order.id,
        sale_id: result.sale.id,
        ...discountFieldsForToolResult(result),
      });
    }

    if (action === 'get') {
      if (!reservationId) {
        throw new ReservableCatalogItemError('Missing reservation UUID for get. Pass id (alias: reservation_id).');
      }

      const { data, error } = await supabaseAdmin
        .from('reservations')
        .select('*, catalog_item:catalog_items(name, site_id)')
        .eq('id', reservationId)
        .single();

      if (error) throw new Error(error.message);
      
      // Ensure the user has access to it via site_id comparison on the joined item
      if (site_id && data.catalog_item && (data.catalog_item as any).site_id !== site_id) {
         throw new Error('Reservation does not belong to site');
      }
      
      return NextResponse.json({ success: true, reservation: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('reservations')
        .select('*, catalog_item:catalog_items!inner(name, site_id)', { count: 'exact' });

      if (site_id) query = query.eq('catalog_items.site_id', site_id);
      if (catalog_item_id) query = query.eq('catalog_item_id', catalog_item_id);
      if (lead_id) query = query.eq('lead_id', lead_id);
      if (updates.status) query = query.eq('status', updates.status);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('start_time', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, reservations: data, count });
    }

    if (action === 'update') {
      if (!reservationId) {
        throw new ReservableCatalogItemError('Missing reservation UUID for update. Pass id (alias: reservation_id).');
      }

      const { data: existing, error: getErr } = await supabaseAdmin
        .from('reservations')
        .select('id, catalog_item_id, start_time, end_time, quantity, catalog_items!inner(site_id)')
        .eq('id', reservationId)
        .single();

      if (getErr || !existing) throw new Error('Reservation not found');
      const existingSiteId = (existing.catalog_items as any).site_id;
      if (site_id && existingSiteId !== site_id) {
        throw new Error('Reservation not found or does not belong to site');
      }

      const existingFamily = await resolveReservationFamily(existing.catalog_item_id);
      const existingRole = classifyRoundRobinRole(existingFamily);
      const requestedCatalogItemId =
        catalog_item_id && catalog_item_id !== existing.catalog_item_id ? catalog_item_id : undefined;
      const isCancel = updates.status === 'cancelled';
      const shouldAssignRoundRobin =
        existingRole !== 'named' && !requestedCatalogItemId && !isCancel;

      const hasUpdate =
        updates.status !== undefined ||
        updates.quantity !== undefined ||
        updates.start_time !== undefined ||
        updates.end_time !== undefined ||
        updates.notes !== undefined ||
        lead_id !== undefined ||
        Boolean(requestedCatalogItemId) ||
        shouldAssignRoundRobin;
      if (!hasUpdate) {
        throw new ReservableCatalogItemError(
          'No fields to update. Pass at least one of: status, start_time, end_time, quantity, notes, lead_id, catalog_item_id.'
        );
      }

      const payload: any = {};
      if (updates.status !== undefined) payload.status = updates.status;
      if (updates.quantity !== undefined) {
        const qty = Number(updates.quantity);
        if (!Number.isFinite(qty) || qty < 1) {
          throw new ReservableCatalogItemError('quantity must be at least 1');
        }
        payload.quantity = qty;
      }
      if (updates.start_time !== undefined) payload.start_time = updates.start_time;
      if (updates.end_time !== undefined) payload.end_time = updates.end_time;
      if (updates.notes !== undefined) payload.notes = updates.notes;
      if (lead_id !== undefined) payload.lead_id = lead_id;

      let nextCatalogItemId = existing.catalog_item_id;
      let assignment = null;
      if (requestedCatalogItemId || shouldAssignRoundRobin) {
        assignment = await resolveReservationUpdateTarget({
          existingCatalogItemId: existing.catalog_item_id,
          requestedCatalogItemId: requestedCatalogItemId,
          start: updates.start_time ?? existing.start_time,
          end: updates.end_time ?? existing.end_time,
          quantity: payload.quantity ?? existing.quantity ?? 1,
          excludeReservationId: reservationId,
        });
        nextCatalogItemId = assignment.catalog_item_id;
        payload.catalog_item_id = nextCatalogItemId;
      }

      const timesOrQuantityChange =
        updates.start_time !== undefined ||
        updates.end_time !== undefined ||
        updates.quantity !== undefined ||
        payload.catalog_item_id !== undefined;
      if (timesOrQuantityChange) {
        const slot = await assertReservationSlot(
          existingSiteId,
          nextCatalogItemId,
          updates.start_time ?? existing.start_time,
          updates.end_time ?? existing.end_time,
          payload.quantity ?? existing.quantity ?? 1,
          true,
          reservationId
        );
        payload.start_time = slot.start_utc;
        payload.end_time = slot.end_utc;
      }

      payload.updated_at = new Date().toISOString();

      const { data, error } = await supabaseAdmin
        .from('reservations')
        .update(payload)
        .eq('id', reservationId)
        .select()
        .single();

      if (error) throw new Error(error.message);
      if (data && site_id) {
        const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
        fireWorkflowDispatch({ table: 'reservations', op: 'update', row: data, site_id });
      }
      return NextResponse.json({
        success: true,
        reservation: data,
        ...(assignment ? { assignment } : {}),
      });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Reservations tool error:', error);
    const status =
      error instanceof ReservableCatalogItemError || error?.name === 'ReservableCatalogItemError' || error?.statusCode === 400
        ? 400
        : 500;
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        ...(error.catalog_item_id ? { catalog_item_id: error.catalog_item_id } : {}),
        ...(error.reservation_id ? { reservation_id: error.reservation_id } : {}),
      },
      { status }
    );
  }
}