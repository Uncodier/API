import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, name, description, icon, color, is_active, limit = 50, offset = 0, search } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (!site_id) {
      return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    }

    if (action === 'create') {
      if (!name) throw new Error('Missing name for category');
      
      let finalUserId = body.user_id;
      if (!finalUserId) {
        // Fallback to site's owner user_id if not provided
        const { data: siteData, error: siteErr } = await supabaseAdmin
          .from('sites')
          .select('user_id')
          .eq('id', site_id)
          .single();
          
        if (siteErr || !siteData) {
          throw new Error('Could not determine user_id for category creation');
        }
        finalUserId = siteData.user_id;
      }

      const { data, error } = await supabaseAdmin
        .from('categories')
        .insert({
          site_id,
          user_id: finalUserId,
          name,
          description,
          icon,
          color,
          is_active: is_active !== undefined ? is_active : true,
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, category: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('categories')
        .select('*', { count: 'exact' })
        .eq('site_id', site_id);

      if (is_active !== undefined) query = query.eq('is_active', is_active);
      if (search) query = query.ilike('name', `%${search}%`);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('name', { ascending: true });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, categories: data, count });
    }

    if (action === 'get') {
      if (!id) throw new Error('Missing id');
      
      const { data, error } = await supabaseAdmin
        .from('categories')
        .select('*')
        .eq('id', id)
        .eq('site_id', site_id)
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, category: data });
    }

    if (action === 'update') {
      if (!id) throw new Error('Missing id');
      
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (icon !== undefined) updates.icon = icon;
      if (color !== undefined) updates.color = color;
      if (is_active !== undefined) updates.is_active = is_active;
      
      updates.updated_at = new Date().toISOString();

      const { data, error } = await supabaseAdmin
        .from('categories')
        .update(updates)
        .eq('id', id)
        .eq('site_id', site_id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, category: data });
    }

    if (action === 'delete') {
      if (!id) throw new Error('Missing id');
      
      const { error } = await supabaseAdmin
        .from('categories')
        .delete()
        .eq('id', id)
        .eq('site_id', site_id);

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Categories tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
