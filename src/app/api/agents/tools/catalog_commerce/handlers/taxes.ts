import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export type TaxResource = 'tax' | 'catalog_item_tax';

type TaxBody = {
  action: string;
  id?: string;
  site_id?: string;
  limit?: number;
  offset?: number;
  name?: string;
  rate?: number;
  is_active?: boolean;
  catalog_item_id?: string;
  tax_id?: string;
};

function uniquePairError(error: { message?: string; code?: string } | null, label: string) {
  if (!error) return null;
  if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
    return `${label} already exists`;
  }
  return error.message || 'Database error';
}

function invalidRate(rate?: number) {
  if (rate === undefined) return false;
  return typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100;
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

async function assertTaxOnSite(taxId: string, siteId: string) {
  const { data, error } = await supabaseAdmin.from('taxes').select('id, site_id').eq('id', taxId).single();
  if (error || !data) throw new Error(`Tax not found: ${taxId}`);
  if (data.site_id !== siteId) throw new Error(`Tax ${taxId} does not belong to site ${siteId}`);
}

async function handleTax(body: Record<string, unknown>) {
  const { action, id, site_id, limit = 50, offset = 0, name, rate, is_active } = body as TaxBody;

  if (action === 'create') {
    if (!site_id) return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    if (!name) return NextResponse.json({ success: false, error: 'Missing name' }, { status: 400 });

    if (invalidRate(rate)) {
      return NextResponse.json({ success: false, error: 'rate must be a number between 0 and 100' }, { status: 400 });
    }

    const payload: Record<string, unknown> = { site_id, name: name.trim() };
    if (rate !== undefined) payload.rate = rate;
    if (is_active !== undefined) payload.is_active = is_active;

    const { data, error } = await supabaseAdmin.from('taxes').insert(payload).select().single();
    if (error) throw new Error(uniquePairError(error, 'Tax') || error.message);
    return NextResponse.json({ success: true, tax: data });
  }

  if (action === 'update') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });

    if (invalidRate(rate)) {
      return NextResponse.json({ success: false, error: 'rate must be a number between 0 and 100' }, { status: 400 });
    }

    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) payload.name = name.trim();
    if (rate !== undefined) payload.rate = rate;
    if (is_active !== undefined) payload.is_active = is_active;

    let query = supabaseAdmin.from('taxes').update(payload).eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.select().single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, tax: data });
  }

  if (action === 'get') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });

    let query = supabaseAdmin.from('taxes').select('*').eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, tax: data });
  }

  if (action === 'list') {
    let query = supabaseAdmin.from('taxes').select('*', { count: 'exact' });
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error, count } = await query
      .range(Number(offset), Number(offset) + Number(limit) - 1)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, taxes: data, count });
  }

  if (action === 'delete') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    let query = supabaseAdmin.from('taxes').delete().eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);
    const { error } = await query;
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Invalid action for tax' }, { status: 400 });
}

async function handleCatalogItemTax(body: Record<string, unknown>) {
  const { action, id, site_id, limit = 50, offset = 0, catalog_item_id, tax_id } = body as TaxBody;

  if (action === 'create') {
    if (!site_id) return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
    if (!catalog_item_id || !tax_id) {
      return NextResponse.json({ success: false, error: 'Missing catalog_item_id or tax_id' }, { status: 400 });
    }

    await assertCatalogItemOnSite(catalog_item_id, site_id);
    await assertTaxOnSite(tax_id, site_id);

    const payload = { site_id, catalog_item_id, tax_id };

    const { data, error } = await supabaseAdmin
      .from('catalog_item_taxes')
      .insert(payload)
      .select('*, tax:taxes(*)')
      .single();

    if (error) throw new Error(uniquePairError(error, 'Catalog item tax') || error.message);
    return NextResponse.json({ success: true, catalog_item_tax: data });
  }

  if (action === 'update') {
    return NextResponse.json(
      { success: false, error: 'update is not supported for catalog_item_tax; delete and create instead' },
      { status: 400 }
    );
  }

  if (action === 'get') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });

    let query = supabaseAdmin.from('catalog_item_taxes').select('*, tax:taxes(*)').eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);

    const { data, error } = await query.single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, catalog_item_tax: data });
  }

  if (action === 'list') {
    let query = supabaseAdmin.from('catalog_item_taxes').select('*, tax:taxes(*)', { count: 'exact' });
    if (site_id) query = query.eq('site_id', site_id);
    if (catalog_item_id) query = query.eq('catalog_item_id', catalog_item_id);
    if (tax_id) query = query.eq('tax_id', tax_id);

    const { data, error, count } = await query
      .range(Number(offset), Number(offset) + Number(limit) - 1)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, catalog_item_taxes: data, count });
  }

  if (action === 'delete') {
    if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
    let query = supabaseAdmin.from('catalog_item_taxes').delete().eq('id', id);
    if (site_id) query = query.eq('site_id', site_id);
    
    const { error } = await query;
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Invalid action for catalog_item_tax' }, { status: 400 });
}

export async function handleTaxesAction(resource: TaxResource, body: Record<string, unknown>) {
  if (resource === 'tax') return handleTax(body);
  return handleCatalogItemTax(body);
}
