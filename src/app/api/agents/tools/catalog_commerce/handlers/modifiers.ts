import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

type ModifierResource = 'modifier_group' | 'modifier_group_item' | 'item_modifier_group';

function uniquePairError(error: { message?: string; code?: string } | null, label: string) {
  if (!error) return null;
  if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
    return `${label} already exists`;
  }
  return error.message || 'Database error';
}

async function assertCatalogItemOnSite(catalogItemId: string, siteId: string) {
  const { data, error } = await supabaseAdmin
    .from('catalog_items')
    .select('id, site_id')
    .eq('id', catalogItemId)
    .single();
  if (error || !data) throw new Error(`Catalog item not found: ${catalogItemId}`);
  if (data.site_id !== siteId) throw new Error(`Catalog item ${catalogItemId} does not belong to site ${siteId}`);
  return data;
}

async function assertModifierGroupOnSite(modifierGroupId: string, siteId: string) {
  const { data, error } = await supabaseAdmin
    .from('modifier_groups')
    .select('id, site_id')
    .eq('id', modifierGroupId)
    .single();
  if (error || !data) throw new Error(`Modifier group not found: ${modifierGroupId}`);
  if (data.site_id !== siteId) {
    throw new Error(`Modifier group ${modifierGroupId} does not belong to site ${siteId}`);
  }
  return data;
}

function validateSelectBounds(minSelect?: number, maxSelect?: number | null) {
  if (minSelect !== undefined && (typeof minSelect !== 'number' || minSelect < 0 || !Number.isFinite(minSelect))) {
    throw new Error('min_select must be a non-negative number');
  }
  if (maxSelect !== undefined && maxSelect !== null) {
    if (typeof maxSelect !== 'number' || !Number.isFinite(maxSelect)) {
      throw new Error('max_select must be a number or null');
    }
    const min = minSelect ?? 0;
    if (maxSelect < min) throw new Error('max_select must be >= min_select');
  }
}

async function handleModifierGroup(body: Record<string, unknown>) {
  const { action, id, site_id, limit = 50, offset = 0, search, name, description, min_select, max_select, sort_order } =
    body as {
      action: string;
      id?: string;
      site_id?: string;
      limit?: number;
      offset?: number;
      search?: string;
      name?: string;
      description?: string;
      min_select?: number;
      max_select?: number | null;
      sort_order?: number;
    };

  if (action === 'create') {
    if (!site_id) return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ success: false, error: 'Missing name' }, { status: 400 });
    }
    validateSelectBounds(min_select ?? 0, max_select);

    const { data, error } = await supabaseAdmin
      .from('modifier_groups')
      .insert({
        site_id,
        name: name.trim(),
        description: description ?? null,
        min_select: min_select ?? 0,
        max_select: max_select === undefined ? null : max_select,
        sort_order: sort_order ?? 0,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, modifier_group: data });
  }

  if (action === 'update') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });

    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) payload.name = typeof name === 'string' ? name.trim() : name;
    if (description !== undefined) payload.description = description;
    if (min_select !== undefined) payload.min_select = min_select;
    if (max_select !== undefined) payload.max_select = max_select;
    if (sort_order !== undefined) payload.sort_order = sort_order;

    if (min_select !== undefined || max_select !== undefined) {
      let nextMin = min_select;
      let nextMax = max_select;
      if (nextMin === undefined || nextMax === undefined) {
        const { data: existing } = await supabaseAdmin
          .from('modifier_groups')
          .select('min_select, max_select')
          .eq('id', id)
          .single();
        nextMin = nextMin ?? existing?.min_select ?? 0;
        nextMax = nextMax === undefined ? existing?.max_select ?? null : nextMax;
      }
      validateSelectBounds(nextMin, nextMax);
    }

    let query = supabaseAdmin.from('modifier_groups').update(payload).eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.select().single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, modifier_group: data });
  }

  if (action === 'get') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });

    let query = supabaseAdmin.from('modifier_groups').select('*').eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data: group, error } = await query.single();
    if (error) throw new Error(error.message);

    const { data: options, error: optErr } = await supabaseAdmin
      .from('modifier_group_items')
      .select('*, catalog_item:catalog_items(id, name, target_sale_price, currency, status, availability_status)')
      .eq('modifier_group_id', id)
      .order('sort_order', { ascending: true });

    if (optErr) throw new Error(optErr.message);
    return NextResponse.json({ success: true, modifier_group: group, options: options || [] });
  }

  if (action === 'list') {
    let query = supabaseAdmin.from('modifier_groups').select('*', { count: 'exact' });
    if (site_id) query = query.eq('site_id', site_id);
    if (search) query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);

    const { data, error, count } = await query
      .range(Number(offset), Number(offset) + Number(limit) - 1)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, modifier_groups: data, count });
  }

  if (action === 'delete') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    let query = supabaseAdmin.from('modifier_groups').delete().eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);
    const { error } = await query;
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { success: false, error: 'Invalid action for resource modifier_group' },
    { status: 400 }
  );
}

async function handleModifierGroupItem(body: Record<string, unknown>) {
  const {
    action,
    id,
    site_id,
    limit = 50,
    offset = 0,
    modifier_group_id,
    catalog_item_id,
    sort_order,
  } = body as {
    action: string;
    id?: string;
    site_id?: string;
    limit?: number;
    offset?: number;
    modifier_group_id?: string;
    catalog_item_id?: string;
    sort_order?: number;
  };

  if (action === 'create') {
    if (!site_id) return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    if (!modifier_group_id || !catalog_item_id) {
      return NextResponse.json(
        { success: false, error: 'Missing modifier_group_id or catalog_item_id' },
        { status: 400 }
      );
    }

    await assertModifierGroupOnSite(modifier_group_id, site_id);
    await assertCatalogItemOnSite(catalog_item_id, site_id);

    const { data, error } = await supabaseAdmin
      .from('modifier_group_items')
      .insert({
        site_id,
        modifier_group_id,
        catalog_item_id,
        sort_order: sort_order ?? 0,
      })
      .select('*, catalog_item:catalog_items(id, name, target_sale_price, currency)')
      .single();

    const pairErr = uniquePairError(error, 'Modifier group option');
    if (pairErr) throw new Error(pairErr);
    return NextResponse.json({ success: true, modifier_group_item: data });
  }

  if (action === 'update') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    if (sort_order === undefined) {
      return NextResponse.json({ success: false, error: 'Nothing to update (sort_order)' }, { status: 400 });
    }

    let query = supabaseAdmin
      .from('modifier_group_items')
      .update({ sort_order })
      .eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query
      .select('*, catalog_item:catalog_items(id, name, target_sale_price, currency)')
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, modifier_group_item: data });
  }

  if (action === 'list') {
    let query = supabaseAdmin
      .from('modifier_group_items')
      .select('*, catalog_item:catalog_items(id, name, target_sale_price, currency, status)', { count: 'exact' });

    if (site_id) query = query.eq('site_id', site_id);
    if (modifier_group_id) query = query.eq('modifier_group_id', modifier_group_id);
    if (catalog_item_id) query = query.eq('catalog_item_id', catalog_item_id);

    const { data, error, count } = await query
      .range(Number(offset), Number(offset) + Number(limit) - 1)
      .order('sort_order', { ascending: true });

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, modifier_group_items: data, count });
  }

  if (action === 'delete') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    let query = supabaseAdmin.from('modifier_group_items').delete().eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);
    const { error } = await query;
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true });
  }

  if (action === 'get') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    let query = supabaseAdmin
      .from('modifier_group_items')
      .select('*, catalog_item:catalog_items(id, name, target_sale_price, currency)')
      .eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);
    const { data, error } = await query.single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, modifier_group_item: data });
  }

  return NextResponse.json(
    { success: false, error: 'Invalid action for resource modifier_group_item' },
    { status: 400 }
  );
}

async function handleItemModifierGroup(body: Record<string, unknown>) {
  const {
    action,
    id,
    site_id,
    limit = 50,
    offset = 0,
    catalog_item_id,
    modifier_group_id,
    sort_order,
  } = body as {
    action: string;
    id?: string;
    site_id?: string;
    limit?: number;
    offset?: number;
    catalog_item_id?: string;
    modifier_group_id?: string;
    sort_order?: number;
  };

  if (action === 'create') {
    if (!site_id) return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    if (!catalog_item_id || !modifier_group_id) {
      return NextResponse.json(
        { success: false, error: 'Missing catalog_item_id or modifier_group_id' },
        { status: 400 }
      );
    }

    await assertCatalogItemOnSite(catalog_item_id, site_id);
    await assertModifierGroupOnSite(modifier_group_id, site_id);

    const { data, error } = await supabaseAdmin
      .from('catalog_item_modifier_groups')
      .insert({
        site_id,
        catalog_item_id,
        modifier_group_id,
        sort_order: sort_order ?? 0,
      })
      .select('*, modifier_group:modifier_groups(*)')
      .single();

    const pairErr = uniquePairError(error, 'item modifier group attachment');
    if (pairErr) throw new Error(pairErr);
    return NextResponse.json({ success: true, item_modifier_group: data });
  }

  if (action === 'update') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    if (sort_order === undefined) {
      return NextResponse.json({ success: false, error: 'Nothing to update (sort_order)' }, { status: 400 });
    }

    let query = supabaseAdmin
      .from('catalog_item_modifier_groups')
      .update({ sort_order })
      .eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.select('*, modifier_group:modifier_groups(*)').single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, item_modifier_group: data });
  }

  if (action === 'list') {
    let query = supabaseAdmin
      .from('catalog_item_modifier_groups')
      .select('*, modifier_group:modifier_groups(*)', { count: 'exact' });

    if (site_id) query = query.eq('site_id', site_id);
    if (catalog_item_id) query = query.eq('catalog_item_id', catalog_item_id);
    if (modifier_group_id) query = query.eq('modifier_group_id', modifier_group_id);

    const { data, error, count } = await query
      .range(Number(offset), Number(offset) + Number(limit) - 1)
      .order('sort_order', { ascending: true });

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, item_modifier_groups: data, count });
  }

  if (action === 'delete') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    let query = supabaseAdmin.from('catalog_item_modifier_groups').delete().eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);
    const { error } = await query;
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true });
  }

  if (action === 'get') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    let query = supabaseAdmin
      .from('catalog_item_modifier_groups')
      .select('*, modifier_group:modifier_groups(*)')
      .eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);
    const { data, error } = await query.single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, item_modifier_group: data });
  }

  return NextResponse.json(
    { success: false, error: 'Invalid action for resource item_modifier_group' },
    { status: 400 }
  );
}

export async function handleModifierAction(resource: ModifierResource, body: Record<string, unknown>) {
  if (resource === 'modifier_group') return handleModifierGroup(body);
  if (resource === 'modifier_group_item') return handleModifierGroupItem(body);
  return handleItemModifierGroup(body);
}
