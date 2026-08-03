import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, limit = 50, offset = 0, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'update') {
      const payload: any = {};
      if (updates.is_marketplace_listed !== undefined) payload.is_marketplace_listed = updates.is_marketplace_listed;
      if (updates.is_reservation !== undefined) payload.is_reservation = updates.is_reservation;
      if (updates.is_purchasable !== undefined) payload.is_purchasable = updates.is_purchasable;
      if (updates.is_recurring !== undefined) payload.is_recurring = updates.is_recurring;
      if (updates.is_pos_available !== undefined) payload.is_pos_available = updates.is_pos_available;
      if (updates.digital_subtype !== undefined) payload.digital_subtype = updates.digital_subtype;
      if (updates.status !== undefined) payload.status = updates.status;
      if (updates.kind !== undefined) payload.kind = updates.kind;
      if (updates.availability_status !== undefined) payload.availability_status = updates.availability_status;
      if (updates.currency !== undefined) payload.currency = updates.currency;
      if (updates.category_id !== undefined) payload.category_id = updates.category_id;
      if (updates.pass_uses !== undefined) payload.pass_uses = updates.pass_uses;
      if (updates.pass_validity_days !== undefined) payload.pass_validity_days = updates.pass_validity_days;

      if (Object.keys(payload).length > 0) {
        payload.updated_at = new Date().toISOString();
      }

      const { data, error } = await supabaseAdmin
        .from('catalog_items')
        .update(payload)
        .eq('id', id)
        .eq('site_id', site_id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      
      let hint: string | undefined;
      if (payload.is_reservation) {
        const { count } = await supabaseAdmin.from('reservation_schedules').select('id', { count: 'exact', head: true }).eq('catalog_item_id', id);
        if (count === 0) {
          hint = 'Item marked as reservable but has no schedule. Use reservation_schedules tool to create one.';
        }
      }

      return NextResponse.json({ success: true, item: data, hint });
    }

    if (action === 'get') {
      const { data, error } = await supabaseAdmin
        .from('catalog_items')
        .select('*')
        .eq('id', id)
        .eq('site_id', site_id)
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, item: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('catalog_items')
        .select('*', { count: 'exact' });

      if (site_id) query = query.eq('site_id', site_id);
      if (updates.kind) query = query.eq('kind', updates.kind);
      if (updates.digital_subtype) query = query.eq('digital_subtype', updates.digital_subtype);
      if (updates.status) query = query.eq('status', updates.status);
      if (updates.availability_status) query = query.eq('availability_status', updates.availability_status);
      if (updates.currency) query = query.eq('currency', updates.currency);
      if (updates.category_id) query = query.eq('category_id', updates.category_id);
      if (updates.is_reservation !== undefined) query = query.eq('is_reservation', updates.is_reservation);
      if (updates.is_purchasable !== undefined) query = query.eq('is_purchasable', updates.is_purchasable);
      if (updates.is_recurring !== undefined) query = query.eq('is_recurring', updates.is_recurring);
      if (updates.is_pos_available !== undefined) query = query.eq('is_pos_available', updates.is_pos_available);
      if (updates.is_marketplace_listed !== undefined) query = query.eq('is_marketplace_listed', updates.is_marketplace_listed);
      
      if (updates.search) {
        query = query.or(`name.ilike.%${updates.search}%,description.ilike.%${updates.search}%`);
      }

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, items: data, count });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Catalog Commerce tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
