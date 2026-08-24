import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getAvailableSlots, assertReservationSlot } from '@/lib/reservations/availability';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, catalog_item_id, lead_id, site_id, limit = 50, offset = 0, entitlement_id, buyer_user_id, owner_site_id, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

        if (action === 'get_available_slots') {
      const { from_date, to_date, quantity = 1 } = updates;
      if (!catalog_item_id || !from_date || !to_date) throw new Error('Missing required fields for get_available_slots: catalog_item_id, from_date, to_date');

      const slots = await getAvailableSlots(catalog_item_id, from_date, to_date, quantity);
      return NextResponse.json({ success: true, slots });
    }

    if (action === 'create') {
      if (!site_id) throw new Error('Missing site_id');
      if (!catalog_item_id) throw new Error('Missing catalog_item_id');
      if (!lead_id) throw new Error('Missing lead_id');
      if (!updates.start_time || !updates.end_time) throw new Error('Missing start/end times');

      const quantity = updates.quantity ?? 1;

      // Validate capacity and schedule
      await assertReservationSlot(site_id, catalog_item_id, updates.start_time, updates.end_time, quantity, true); // true = isAdmin

      // If entitlement_id is provided, validate it
      if (entitlement_id) {
        const { data: ent, error: entErr } = await supabaseAdmin
          .from('entitlements')
          .select('id, status, uses_remaining, catalog_item_id')
          .eq('id', entitlement_id)
          .eq('site_id', site_id)
          .single();

        if (entErr || !ent) throw new Error(`Entitlement not found: ${entitlement_id}`);
        if (ent.status !== 'active') throw new Error(`Entitlement ${entitlement_id} is not active`);
        if (ent.uses_remaining !== null && ent.uses_remaining < quantity) {
          throw new Error(`Entitlement ${entitlement_id} does not have enough uses remaining`);
        }

        // Validate pass_redeemable_items relation
        const { data: passRedeem, error: passErr } = await supabaseAdmin
          .from('pass_redeemable_items')
          .select('id')
          .eq('pass_catalog_item_id', ent.catalog_item_id)
          .eq('reservable_catalog_item_id', catalog_item_id)
          .eq('site_id', site_id)
          .maybeSingle();

        if (passErr) throw new Error(passErr.message);
        if (!passRedeem) {
          throw new Error(`Catalog item ${catalog_item_id} is not redeemable with pass ${ent.catalog_item_id}`);
        }
      }

      const payload = {
        catalog_item_id,
        lead_id,
        site_id,
        buyer_user_id: buyer_user_id || null,
        owner_site_id: owner_site_id || null,
        entitlement_id: entitlement_id || null,
        start_time: updates.start_time,
        end_time: updates.end_time,
        quantity,
        status: updates.status || 'pending',
        notes: updates.notes || null,
      };

      const { data, error } = await supabaseAdmin
        .from('reservations')
        .insert(payload)
        .select()
        .single();

      if (error) throw new Error(error.message);
      if (data && site_id) {
        const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
        fireWorkflowDispatch({ table: 'reservations', op: 'insert', row: data, site_id });
      }
      return NextResponse.json({ success: true, reservation: data });
    }

    if (action === 'get') {
      if (!id) throw new Error('Missing id');

      const { data, error } = await supabaseAdmin
        .from('reservations')
        .select('*, catalog_item:catalog_items(name, site_id)')
        .eq('id', id)
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
      if (!id) throw new Error('Missing id');
      
      const payload: any = {};
      if (updates.status !== undefined) payload.status = updates.status;
      if (updates.quantity !== undefined) payload.quantity = updates.quantity;
      if (updates.start_time !== undefined) payload.start_time = updates.start_time;
      if (updates.end_time !== undefined) payload.end_time = updates.end_time;
      
      if (Object.keys(payload).length > 0) {
        payload.updated_at = new Date().toISOString();
      }

      // First check if it belongs to site
      if (site_id) {
         const { data: existing, error: getErr } = await supabaseAdmin
            .from('reservations')
            .select('catalog_items!inner(site_id)')
            .eq('id', id)
            .single();
         if (getErr || !existing || (existing.catalog_items as any).site_id !== site_id) {
            throw new Error('Reservation not found or does not belong to site');
         }
      }

      const { data, error } = await supabaseAdmin
        .from('reservations')
        .update(payload)
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      if (data && site_id) {
        const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
        fireWorkflowDispatch({ table: 'reservations', op: 'update', row: data, site_id });
      }
      return NextResponse.json({ success: true, reservation: data });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Reservations tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}