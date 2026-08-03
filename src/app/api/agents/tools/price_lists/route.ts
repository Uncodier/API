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
        .from('price_lists')
        .select('*, items:price_list_items(id, catalog_item_id, unit_price)')
        .eq('id', id)
        .eq('site_id', site_id)
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, price_list: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('price_lists')
        .select('*', { count: 'exact' });

      if (site_id) query = query.eq('site_id', site_id);
      if (updates.is_active !== undefined) query = query.eq('is_active', updates.is_active);
      if (updates.is_default !== undefined) query = query.eq('is_default', updates.is_default);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, price_lists: data, count });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Price Lists tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
