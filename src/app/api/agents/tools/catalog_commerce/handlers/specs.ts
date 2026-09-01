import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export type SpecResource = 'item_spec_category' | 'item_spec' | 'catalog_item_spec';

type SpecBody = {
  action: string;
  id?: string;
  site_id?: string;
  limit?: number;
  offset?: number;
  name?: string;
  slug?: string;
  is_system?: boolean;
  category_id?: string;
  image_url?: string;
  video_url?: string;
  address?: string;
  city?: string;
  metadata?: Record<string, unknown>;
  catalog_item_id?: string;
  item_spec_id?: string;
  sort_order?: number;
};

function uniquePairError(error: { message?: string; code?: string } | null, label: string) {
  if (!error) return null;
  if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
    return `${label} already exists`;
  }
  return error.message || 'Database error';
}

function toSlug(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'category';
}

async function assertCatalogItemOnSite(catalogItemId: string, siteId: string) {
  const { data, error } = await supabaseAdmin
    .from('catalog_items')
    .select('id, site_id')
    .eq('id', catalogItemId)
    .single();
  if (error || !data) throw new Error(`Catalog item not found: ${catalogItemId}`);
  if (data.site_id !== siteId) throw new Error(`Catalog item ${catalogItemId} does not belong to site ${siteId}`);
}

async function assertItemSpecOnSite(itemSpecId: string, siteId: string) {
  const { data, error } = await supabaseAdmin
    .from('item_specs')
    .select('id, site_id')
    .eq('id', itemSpecId)
    .single();
  if (error || !data) throw new Error(`Item spec not found: ${itemSpecId}`);
  if (data.site_id !== siteId) throw new Error(`Item spec ${itemSpecId} does not belong to site ${siteId}`);
}

async function handleItemSpecCategory(body: Record<string, unknown>) {
  const { action, id, site_id, limit = 50, offset = 0, name, slug, is_system } = body as SpecBody;

  if (action === 'create') {
    if (!site_id) return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    if (!name || !name.trim()) return NextResponse.json({ success: false, error: 'Missing name' }, { status: 400 });

    const payload: Record<string, unknown> = {
      site_id,
      name: name.trim(),
      slug: slug?.trim() ? toSlug(slug) : toSlug(name),
    };
    if (is_system !== undefined) payload.is_system = is_system;

    const { data, error } = await supabaseAdmin.from('item_spec_categories').insert(payload).select().single();
    if (error) throw new Error(uniquePairError(error, 'Spec category') || error.message);
    return NextResponse.json({ success: true, item_spec_category: data });
  }

  if (action === 'update') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });

    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) payload.name = name.trim();
    if (slug !== undefined) payload.slug = toSlug(slug);
    if (is_system !== undefined) payload.is_system = is_system;

    let query = supabaseAdmin.from('item_spec_categories').update(payload).eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.select().single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, item_spec_category: data });
  }

  if (action === 'get') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });

    let query = supabaseAdmin.from('item_spec_categories').select('*').eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, item_spec_category: data });
  }

  if (action === 'list') {
    let query = supabaseAdmin.from('item_spec_categories').select('*', { count: 'exact' });
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error, count } = await query
      .range(Number(offset), Number(offset) + Number(limit) - 1)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, item_spec_categories: data, count });
  }

  if (action === 'delete') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    let query = supabaseAdmin.from('item_spec_categories').delete().eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);
    const { error } = await query;
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Invalid action for item_spec_category' }, { status: 400 });
}

async function handleItemSpec(body: Record<string, unknown>) {
  const {
    action,
    id,
    site_id,
    limit = 50,
    offset = 0,
    category_id,
    name,
    image_url,
    video_url,
    address,
    city,
    metadata,
  } = body as SpecBody;

  if (action === 'create') {
    if (!site_id) return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    if (!name || !category_id) {
      return NextResponse.json({ success: false, error: 'Missing name or category_id' }, { status: 400 });
    }

    const payload: Record<string, unknown> = { site_id, category_id, name: name.trim() };
    if (image_url !== undefined) payload.image_url = image_url;
    if (video_url !== undefined) payload.video_url = video_url;
    if (address !== undefined) payload.address = address;
    if (city !== undefined) payload.city = city;
    if (metadata !== undefined) payload.metadata = metadata;

    const { data, error } = await supabaseAdmin.from('item_specs').insert(payload).select().single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, item_spec: data });
  }

  if (action === 'update') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });

    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (category_id !== undefined) payload.category_id = category_id;
    if (name !== undefined) payload.name = name.trim();
    if (image_url !== undefined) payload.image_url = image_url;
    if (video_url !== undefined) payload.video_url = video_url;
    if (address !== undefined) payload.address = address;
    if (city !== undefined) payload.city = city;
    if (metadata !== undefined) payload.metadata = metadata;

    let query = supabaseAdmin.from('item_specs').update(payload).eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.select().single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, item_spec: data });
  }

  if (action === 'get') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });

    let query = supabaseAdmin.from('item_specs').select('*').eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, item_spec: data });
  }

  if (action === 'list') {
    let query = supabaseAdmin.from('item_specs').select('*', { count: 'exact' });
    if (site_id) query = query.eq('site_id', site_id);
    if (category_id) query = query.eq('category_id', category_id);

    const { data, error, count } = await query
      .range(Number(offset), Number(offset) + Number(limit) - 1)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, item_specs: data, count });
  }

  if (action === 'delete') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    let query = supabaseAdmin.from('item_specs').delete().eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);
    const { error } = await query;
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Invalid action for item_spec' }, { status: 400 });
}

async function handleCatalogItemSpec(body: Record<string, unknown>) {
  const { action, site_id, catalog_item_id, item_spec_id, sort_order, limit = 50, offset = 0 } = body as SpecBody;

  if (action === 'create') {
    if (!site_id) return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    if (!catalog_item_id || !item_spec_id) {
      return NextResponse.json({ success: false, error: 'Missing catalog_item_id or item_spec_id' }, { status: 400 });
    }

    await assertCatalogItemOnSite(catalog_item_id, site_id);
    await assertItemSpecOnSite(item_spec_id, site_id);

    const payload = { catalog_item_id, item_spec_id, sort_order: sort_order ?? 0 };

    const { data, error } = await supabaseAdmin
      .from('catalog_item_specs')
      .insert(payload)
      .select('*, item_spec:item_specs(*)')
      .single();

    if (error) throw new Error(uniquePairError(error, 'Catalog item spec') || error.message);
    return NextResponse.json({ success: true, catalog_item_spec: data });
  }

  if (action === 'update') {
    if (!catalog_item_id || !item_spec_id) {
      return NextResponse.json({ success: false, error: 'Missing catalog_item_id or item_spec_id' }, { status: 400 });
    }
    if (sort_order === undefined) {
      return NextResponse.json({ success: false, error: 'Nothing to update (sort_order)' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('catalog_item_specs')
      .update({ sort_order })
      .eq('catalog_item_id', catalog_item_id)
      .eq('item_spec_id', item_spec_id)
      .select('*, item_spec:item_specs(*)')
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, catalog_item_spec: data });
  }

  if (action === 'get') {
    if (!catalog_item_id || !item_spec_id) {
      return NextResponse.json({ success: false, error: 'Missing catalog_item_id or item_spec_id' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('catalog_item_specs')
      .select('*, item_spec:item_specs(*)')
      .eq('catalog_item_id', catalog_item_id)
      .eq('item_spec_id', item_spec_id)
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, catalog_item_spec: data });
  }

  if (action === 'list') {
    let query = supabaseAdmin
      .from('catalog_item_specs')
      .select('*, item_spec:item_specs!inner(*)', { count: 'exact' });
    if (site_id) query = query.eq('item_specs.site_id', site_id);
    if (catalog_item_id) query = query.eq('catalog_item_id', catalog_item_id);
    if (item_spec_id) query = query.eq('item_spec_id', item_spec_id);

    const { data, error, count } = await query
      .range(Number(offset), Number(offset) + Number(limit) - 1)
      .order('sort_order', { ascending: true });

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, catalog_item_specs: data, count });
  }

  if (action === 'delete') {
    if (!catalog_item_id || !item_spec_id) {
      return NextResponse.json({ success: false, error: 'Missing catalog_item_id or item_spec_id' }, { status: 400 });
    }
    const { error } = await supabaseAdmin
      .from('catalog_item_specs')
      .delete()
      .eq('catalog_item_id', catalog_item_id)
      .eq('item_spec_id', item_spec_id);

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Invalid action for catalog_item_spec' }, { status: 400 });
}

export async function handleSpecsAction(resource: SpecResource, body: Record<string, unknown>) {
  if (resource === 'item_spec_category') return handleItemSpecCategory(body);
  if (resource === 'item_spec') return handleItemSpec(body);
  return handleCatalogItemSpec(body);
}
