import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, catalog_item_id, site_id, limit = 50, offset = 0, days, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'upsert') {
      if (!site_id) throw new Error('Missing site_id');
      if (!catalog_item_id) throw new Error('Missing catalog_item_id');
      if (!days) throw new Error('Missing days configuration');
      
      // Verify the item is actually marked as reservable
      const { data: item, error: itemErr } = await supabaseAdmin
        .from('catalog_items')
        .select('is_reservation, site_id')
        .eq('id', catalog_item_id)
        .single();
        
      if (itemErr || !item) throw new Error('Catalog item not found');
      if (item.site_id !== site_id) throw new Error('Catalog item does not belong to site');
      if (!item.is_reservation) throw new Error('Catalog item is not marked as reservable (is_reservation=false)');

      // Validate days keys
      const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const invalidKeys = Object.keys(days).filter(k => !validDays.includes(k));
      if (invalidKeys.length > 0) {
        throw new Error(`Invalid days keys: ${invalidKeys.join(', ')}. Must be lowercase english days.`);
      }

      // Validate at least one day is enabled
      const hasEnabledDay = Object.values(days).some((d: any) => d.enabled === true);
      if (!hasEnabledDay) {
        throw new Error('Schedule must have at least one enabled day');
      }

      const payload = {
        site_id,
        catalog_item_id,
        duration_minutes: updates.duration_minutes ?? 60,
        capacity: updates.capacity ?? 1,
        timezone: updates.timezone,
        days,
        name: updates.name || null,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabaseAdmin
        .from('reservation_schedules')
        .upsert(payload, { onConflict: 'catalog_item_id' })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, schedule: data });
    }

    if (action === 'get') {
      let query = supabaseAdmin.from('reservation_schedules').select('*');
      
      if (id) {
        query = query.eq('id', id);
      } else if (catalog_item_id) {
        query = query.eq('catalog_item_id', catalog_item_id);
      } else {
        throw new Error('Missing id or catalog_item_id');
      }
      
      if (site_id) query = query.eq('site_id', site_id);

      const { data, error } = await query.single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, schedule: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('reservation_schedules')
        .select('*, catalog_item:catalog_items(name)', { count: 'exact' });

      if (site_id) query = query.eq('site_id', site_id);
      if (catalog_item_id) query = query.eq('catalog_item_id', catalog_item_id);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, schedules: data, count });
    }

    if (action === 'delete') {
      let query = supabaseAdmin.from('reservation_schedules').delete();
      
      if (id) {
        query = query.eq('id', id);
      } else if (catalog_item_id) {
        query = query.eq('catalog_item_id', catalog_item_id);
      } else {
        throw new Error('Missing id or catalog_item_id');
      }
      
      if (site_id) query = query.eq('site_id', site_id);

      const { error } = await query;
      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Reservation Schedules tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}