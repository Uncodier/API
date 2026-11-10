import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z, ZodError } from 'zod';
import { authorizeCatalogRequest, CatalogAuthorizationError } from '@/lib/services/catalog-search/auth';

const readSchema = z.object({
  action: z.enum(['list', 'get']), site_id: z.string().uuid(), id: z.string().uuid().optional(),
  is_active: z.boolean().optional(), is_default: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).default(50), offset: z.number().int().min(0).max(100000).default(0),
}).strict().refine(value => value.action !== 'get' || Boolean(value.id), 'get requires id');

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  try {
    if (body && typeof body === 'object' && 'action' in body
      && ['batch_create', 'batch_update'].includes(String(body.action))) {
      return NextResponse.json({ success: false, error: 'Price-list batch is only available through the owner/admin-scoped administrative router' }, { status: 403 });
    }
    const { action, id, site_id, limit, offset, ...updates } = readSchema.parse(body);
    await authorizeCatalogRequest(request, { site_id, channel: 'tools' });

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

      query = query.eq('site_id', site_id);
      if (updates.is_active !== undefined) query = query.eq('is_active', updates.is_active);
      if (updates.is_default !== undefined) query = query.eq('is_default', updates.is_default);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, price_lists: data, count });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: unknown) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ success: false, error: 'Invalid price-list parameters' }, { status: 400 });
    }
    if (error instanceof CatalogAuthorizationError) {
      return NextResponse.json({ success: false, error: 'Price-list access denied' }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: 'Price-list request failed' }, { status: 500 });
  }
}
