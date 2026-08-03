import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, limit = 50, offset = 0, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'get') {
      const { data, error } = await supabaseAdmin
        .from('subscriptions')
        .select('*, catalog_item:catalog_items(id, name, is_recurring)')
        .eq('id', id)
        .eq('site_id', site_id)
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, subscription: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('subscriptions')
        .select('*, catalog_item:catalog_items(id, name, is_recurring)', { count: 'exact' });

      if (site_id) query = query.eq('site_id', site_id);
      if (updates.buyer_user_id) query = query.eq('buyer_user_id', updates.buyer_user_id);
      if (updates.lead_id) query = query.eq('lead_id', updates.lead_id);
      if (updates.catalog_item_id) query = query.eq('catalog_item_id', updates.catalog_item_id);
      if (updates.status) query = query.eq('status', updates.status);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, subscriptions: data, count });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Subscriptions tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
