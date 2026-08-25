import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const CONTENT_FIELDS = [
  'name',
  'description',
  'sku',
  'image_url',
  'cost',
  'lowest_sale_price',
  'target_sale_price',
  'currency',
  'category_id',
  'parent_id',
  'sort_order',
] as const;

const COMMERCE_FIELDS = [
  'kind',
  'digital_subtype',
  'is_marketplace_listed',
  'is_reservation',
  'is_purchasable',
  'is_recurring',
  'is_pos_available',
  'status',
  'availability_status',
  'pass_uses',
  'pass_validity_days',
  'metadata',
] as const;

function pickDefined(source: Record<string, unknown>, keys: readonly string[]) {
  const payload: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) payload[key] = source[key];
  }
  return payload;
}

async function reservationHint(itemId: string, isReservation?: boolean) {
  if (!isReservation) return undefined;
  const { count } = await supabaseAdmin
    .from('reservation_schedules')
    .select('id', { count: 'exact', head: true })
    .eq('catalog_item_id', itemId);
  if (count === 0) {
    return 'Item marked as reservable but has no schedule. Use reservation_schedules tool to create one.';
  }
  return undefined;
}

async function loadItemModifiers(siteId: string, catalogItemId: string) {
  const { data: attachments, error: attachErr } = await supabaseAdmin
    .from('catalog_item_modifier_groups')
    .select('id, modifier_group_id, sort_order')
    .eq('site_id', siteId)
    .eq('catalog_item_id', catalogItemId)
    .order('sort_order', { ascending: true });

  if (attachErr) throw new Error(attachErr.message);
  if (!attachments?.length) return [];

  const groupIds = attachments.map((a) => a.modifier_group_id);
  const { data: groups, error: groupsErr } = await supabaseAdmin
    .from('modifier_groups')
    .select('*')
    .in('id', groupIds);

  if (groupsErr) throw new Error(groupsErr.message);

  const { data: groupItems, error: itemsErr } = await supabaseAdmin
    .from('modifier_group_items')
    .select('*, catalog_item:catalog_items(id, name, target_sale_price, currency, status, availability_status)')
    .eq('site_id', siteId)
    .in('modifier_group_id', groupIds)
    .order('sort_order', { ascending: true });

  if (itemsErr) throw new Error(itemsErr.message);

  const groupsById = new Map((groups || []).map((g) => [g.id, g]));
  const itemsByGroup = new Map<string, typeof groupItems>();
  for (const gi of groupItems || []) {
    const list = itemsByGroup.get(gi.modifier_group_id) || [];
    list.push(gi);
    itemsByGroup.set(gi.modifier_group_id, list);
  }

  return attachments.map((att) => {
    const group = groupsById.get(att.modifier_group_id);
    return {
      attachment_id: att.id,
      sort_order: att.sort_order,
      group: group
        ? {
            ...group,
            options: itemsByGroup.get(att.modifier_group_id) || [],
          }
        : null,
    };
  });
}

export async function handleItemAction(body: Record<string, unknown>) {
  const { action, id, site_id, limit = 50, offset = 0, include_modifiers, ...updates } = body as {
    action: string;
    id?: string;
    site_id?: string;
    limit?: number;
    offset?: number;
    include_modifiers?: boolean;
    [key: string]: unknown;
  };

  if (action === 'create') {
    if (!site_id) {
      return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    }
    if (!updates.name || typeof updates.name !== 'string' || !updates.name.trim()) {
      return NextResponse.json({ success: false, error: 'Missing name' }, { status: 400 });
    }

    const payload: Record<string, unknown> = {
      site_id,
      name: (updates.name as string).trim(),
      kind: updates.kind || 'product',
      status: updates.status || 'active',
      availability_status: updates.availability_status || 'available',
      is_purchasable: updates.is_purchasable !== undefined ? updates.is_purchasable : true,
      ...pickDefined(updates, [...CONTENT_FIELDS.filter((k) => k !== 'name'), ...COMMERCE_FIELDS]),
    };

    const { data, error } = await supabaseAdmin.from('catalog_items').insert(payload).select().single();

    if (error) throw new Error(error.message);

    const hint = await reservationHint(data.id, Boolean(payload.is_reservation));
    return NextResponse.json({ success: true, item: data, hint });
  }

  if (action === 'update') {
    if (!id) {
      return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    }

    const payload: Record<string, unknown> = {
      ...pickDefined(updates, [...CONTENT_FIELDS, ...COMMERCE_FIELDS]),
    };

    if (Object.keys(payload).length > 0) {
      payload.updated_at = new Date().toISOString();
    }

    let query = supabaseAdmin.from('catalog_items').update(payload).eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.select().single();

    if (error) throw new Error(error.message);

    const hint = await reservationHint(id, Boolean(payload.is_reservation));
    return NextResponse.json({ success: true, item: data, hint });
  }

  if (action === 'get') {
    if (!id) {
      return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    }

    let query = supabaseAdmin.from('catalog_items').select('*').eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.single();

    if (error) throw new Error(error.message);

    if (include_modifiers) {
      const modifiers = await loadItemModifiers(data.site_id, data.id);
      return NextResponse.json({ success: true, item: data, modifiers });
    }

    return NextResponse.json({ success: true, item: data });
  }

  if (action === 'list') {
    let query = supabaseAdmin.from('catalog_items').select('*', { count: 'exact' });

    if (site_id) query = query.eq('site_id', site_id);
    if (updates.kind) query = query.eq('kind', updates.kind);
    if (updates.digital_subtype) query = query.eq('digital_subtype', updates.digital_subtype);
    if (updates.status) query = query.eq('status', updates.status);
    if (updates.availability_status) query = query.eq('availability_status', updates.availability_status);
    if (updates.currency) query = query.eq('currency', updates.currency);
    if (updates.category_id) query = query.eq('category_id', updates.category_id);
    if (updates.parent_id) query = query.eq('parent_id', updates.parent_id);
    if (updates.is_reservation !== undefined) query = query.eq('is_reservation', updates.is_reservation);
    if (updates.is_purchasable !== undefined) query = query.eq('is_purchasable', updates.is_purchasable);
    if (updates.is_recurring !== undefined) query = query.eq('is_recurring', updates.is_recurring);
    if (updates.is_pos_available !== undefined) query = query.eq('is_pos_available', updates.is_pos_available);
    if (updates.is_marketplace_listed !== undefined) {
      query = query.eq('is_marketplace_listed', updates.is_marketplace_listed);
    }

    if (updates.search) {
      query = query.or(`name.ilike.%${updates.search}%,description.ilike.%${updates.search}%`);
    }

    const { data, error, count } = await query
      .range(Number(offset), Number(offset) + Number(limit) - 1)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, items: data, count });
  }

  return NextResponse.json({ success: false, error: 'Invalid action for resource item' }, { status: 400 });
}
