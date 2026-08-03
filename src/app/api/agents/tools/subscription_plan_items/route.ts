import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, limit = 50, offset = 0, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'create') {
      const { data, error } = await supabaseAdmin
        .from('subscription_plan_items')
        .insert({
          site_id,
          plan_catalog_item_id: updates.plan_catalog_item_id,
          digital_catalog_item_id: updates.digital_catalog_item_id
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, item: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('subscription_plan_items')
        .select('*, digital:catalog_items!digital_catalog_item_id(id, name, digital_subtype), plan:catalog_items!plan_catalog_item_id(id, name)', { count: 'exact' });

      if (site_id) query = query.eq('site_id', site_id);
      if (updates.plan_catalog_item_id) query = query.eq('plan_catalog_item_id', updates.plan_catalog_item_id);
      if (updates.digital_catalog_item_id) query = query.eq('digital_catalog_item_id', updates.digital_catalog_item_id);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, items: data, count });
    }

    if (action === 'delete') {
      const { error } = await supabaseAdmin
        .from('subscription_plan_items')
        .delete()
        .eq('id', id)
        .eq('site_id', site_id);

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Subscription Plan Items tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
