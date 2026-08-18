import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, site_id, entity_type, entity_id, start_time, end_time, reason } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (!site_id) {
      return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    }

    if (action === 'create') {
      if (!entity_type) throw new Error('Missing entity_type');
      if (!start_time || !end_time) throw new Error('Missing start_time or end_time');
      if (entity_type !== 'global' && !entity_id) {
        throw new Error('entity_id is required when entity_type is not global');
      }

      const payload = {
        site_id,
        entity_type,
        entity_id: entity_id || null,
        start_time,
        end_time,
        reason: reason || null,
      };

      const { data, error } = await supabaseAdmin
        .from('calendar_blocks')
        .insert(payload)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, block: data });
    }

    return NextResponse.json({ success: false, error: `Unsupported action: ${action}` }, { status: 400 });
  } catch (error: any) {
    console.error('Calendar blocks tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
