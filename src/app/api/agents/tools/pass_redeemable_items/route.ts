import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, pass_catalog_item_id, reservable_catalog_item_id, limit = 50, offset = 0 } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'create') {
      if (!site_id) throw new Error('Missing site_id');
      if (!pass_catalog_item_id) throw new Error('Missing pass_catalog_item_id');
      if (!reservable_catalog_item_id) throw new Error('Missing reservable_catalog_item_id');

      // Validate pass is a pass
      const { data: pass, error: passErr } = await supabaseAdmin
        .from('catalog_items')
        .select('digital_subtype, site_id')
        .eq('id', pass_catalog_item_id)
        .single();
      if (passErr || !pass) throw new Error(`Pass item not found: ${pass_catalog_item_id}`);
      if (pass.site_id !== site_id) throw new Error('Pass item does not belong to site');
      if (pass.digital_subtype !== 'pass') throw new Error('Item is not a pass (digital_subtype must be "pass")');

      // Validate reservable is reservable
      const { data: res, error: resErr } = await supabaseAdmin
        .from('catalog_items')
        .select('is_reservation, site_id')
        .eq('id', reservable_catalog_item_id)
        .single();
      if (resErr || !res) throw new Error(`Reservable item not found: ${reservable_catalog_item_id}`);
      if (res.site_id !== site_id) throw new Error('Reservable item does not belong to site');
      if (!res.is_reservation) throw new Error('Item is not reservable (is_reservation must be true)');

      const { data, error } = await supabaseAdmin
        .from('pass_redeemable_items')
        .insert({
          site_id,
          pass_catalog_item_id,
          reservable_catalog_item_id,
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, link: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('pass_redeemable_items')
        .select('*, pass:catalog_items!pass_catalog_item_id(name), reservable:catalog_items!reservable_catalog_item_id(name)', { count: 'exact' });

      if (site_id) query = query.eq('site_id', site_id);
      if (pass_catalog_item_id) query = query.eq('pass_catalog_item_id', pass_catalog_item_id);
      if (reservable_catalog_item_id) query = query.eq('reservable_catalog_item_id', reservable_catalog_item_id);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, links: data, count });
    }

    if (action === 'delete') {
      if (!id) throw new Error('Missing id');
      let query = supabaseAdmin.from('pass_redeemable_items').delete().eq('id', id);
      if (site_id) query = query.eq('site_id', site_id);

      const { error } = await query;
      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Pass Redeemable Items tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
