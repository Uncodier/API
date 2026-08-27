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
      if (updates.status !== undefined) payload.status = updates.status;
      if (updates.expires_at !== undefined) payload.expires_at = updates.expires_at;
      if (updates.uses_total !== undefined) payload.uses_total = updates.uses_total;
      if (updates.uses_remaining !== undefined) payload.uses_remaining = updates.uses_remaining;
      
      if (Object.keys(payload).length > 0) {
        payload.updated_at = new Date().toISOString();
      }

      const { data, error } = await supabaseAdmin
        .from('entitlements')
        .update(payload)
        .eq('id', id)
        .eq('site_id', site_id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, entitlement: data });
    }

    if (action === 'get') {
      const { data, error } = await supabaseAdmin
        .from('entitlements')
        .select('*, catalog_item:catalog_items(id, name, digital_subtype)')
        .eq('id', id)
        .eq('site_id', site_id)
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, entitlement: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('entitlements')
        .select('*, catalog_item:catalog_items(id, name, digital_subtype)', { count: 'exact' });

      if (site_id) query = query.eq('site_id', site_id);
      if (updates.buyer_user_id) query = query.eq('buyer_user_id', updates.buyer_user_id);
      if (updates.owner_site_id) query = query.eq('owner_site_id', updates.owner_site_id);
      if (updates.catalog_item_id) query = query.eq('catalog_item_id', updates.catalog_item_id);
      if (updates.status) query = query.eq('status', updates.status);
      if (updates.source_type) query = query.eq('source_type', updates.source_type);

      if (updates.lead_id) {
        const { data: lead, error: leadErr } = await supabaseAdmin
          .from('leads')
          .select('user_id')
          .eq('id', updates.lead_id)
          .maybeSingle();
        if (leadErr) throw new Error(leadErr.message);
        if (!lead?.user_id) {
          return NextResponse.json({ success: true, entitlements: [], count: 0 });
        }
        query = query.eq('buyer_user_id', lead.user_id);
      }

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, entitlements: data, count });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Entitlements tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
