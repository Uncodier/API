import { NextResponse } from 'next/server';
import { supabaseAdmin as db } from '@/lib/database/supabase-client';
import type { BatchUpdateInput } from './batch-schema';

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

async function assertReferences(table: string, ids: string[], siteId: string) {
  const { data, error } = await db.from(table).select('id').eq('site_id', siteId).in('id', ids);
  fail(error);
  const found = new Set(data?.map(row => row.id));
  if (ids.some(id => !found.has(id))) {
    throw new Error(`Unknown or foreign-site ${table} reference`);
  }
}

/** Bounded set-based writes. Each statement is atomic, not the whole request. */
export async function handleBatchUpdate(input: BatchUpdateInput) {
  const ids: string[] = [];
  // Read in pages smaller than PostgREST's default row cap; never silently truncate.
  for (let offset = 0; offset <= 1000; offset += 100) {
    let query = db.from('catalog_items').select('id').eq('site_id', input.site_id).order('id');
    if (input.item_ids) query = query.in('id', input.item_ids);
    const { data, error } = await query.range(offset, offset + 99);
    fail(error);
    ids.push(...(data || []).map(row => row.id));
    if ((data || []).length < 100) break;
  }
  if (!ids.length || ids.length > 1000 || (input.item_ids && ids.length !== input.item_ids.length)) {
    return NextResponse.json({ success: false, error: 'Selection must contain 1–1000 existing items belonging to this site; use explicit IDs for larger catalogs' }, { status: 400 });
  }
  if (input.expected_count !== undefined && input.expected_count !== ids.length) {
    return NextResponse.json({ success: false, error: 'Selection count changed; preview again', matched_count: ids.length }, { status: 409 });
  }
  if (input.taxes) await assertReferences('taxes', input.taxes.tax_ids, input.site_id);
  if (input.inventory) {
    await assertReferences('locations', [input.inventory.location_id], input.site_id);
    // Legacy inconsistent rows must not be reassigned across tenants by upsert.
    for (let offset = 0; offset < ids.length; offset += 100) {
      const { data, error } = await db.from('inventory_levels').select('site_id')
        .eq('location_id', input.inventory.location_id).in('catalog_item_id', ids.slice(offset, offset + 100));
      fail(error);
      if (data?.some(row => row.site_id !== input.site_id)) throw new Error('Inventory tenant mismatch');
    }
  }
  if (input.dry_run) return NextResponse.json({
    success: true, dry_run: true, matched_count: ids.length, item_ids: ids,
    changes: input.changes || {}, taxes: input.taxes, inventory: input.inventory,
  });

  const completed: { operation: string; item_ids: string[] }[] = [];
  let pending: { operation: string; item_ids: string[] } | undefined;
  try {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      if (Object.keys(input.changes || {}).length) {
        pending = { operation: 'changes', item_ids: chunk };
        const { data, error } = await db.from('catalog_items')
          .update({ ...input.changes, updated_at: new Date().toISOString() })
          .eq('site_id', input.site_id).in('id', chunk).select('id');
        fail(error);
        completed.push({ operation: 'changes', item_ids: (data || []).map(row => row.id) });
        if (data?.length !== chunk.length) throw new Error('Selection changed during execution');
      }
      if (input.taxes) {
        pending = { operation: `taxes_${input.taxes.mode}`, item_ids: chunk };
        if (input.taxes.mode === 'add') {
          for (const tax_id of new Set(input.taxes.tax_ids)) {
            pending = { operation: `taxes_add:${tax_id}`, item_ids: chunk };
            const existing = await db.from('catalog_item_taxes').select('catalog_item_id')
              .eq('site_id', input.site_id).eq('tax_id', tax_id).in('catalog_item_id', chunk);
            fail(existing.error);
            const attached = new Set(existing.data?.map(row => row.catalog_item_id));
            const rows = chunk.filter(id => !attached.has(id)).map(catalog_item_id => ({
              site_id: input.site_id, catalog_item_id, tax_id,
            }));
            if (rows.length) {
              const { error } = await db.from('catalog_item_taxes').upsert(rows, {
                onConflict: 'catalog_item_id,tax_id', ignoreDuplicates: true,
              });
              fail(error);
            }
            completed.push(pending);
          }
        } else {
          const { error } = await db.from('catalog_item_taxes').delete().eq('site_id', input.site_id)
            .in('catalog_item_id', chunk).in('tax_id', input.taxes.tax_ids);
          fail(error);
          completed.push(pending);
        }
      }
      if (input.inventory) {
        pending = { operation: 'inventory_set', item_ids: chunk };
        const { error } = await db.from('inventory_levels').upsert(chunk.map(catalog_item_id => ({
          site_id: input.site_id, catalog_item_id, ...input.inventory, updated_at: new Date().toISOString(),
        })), { onConflict: 'catalog_item_id,location_id' });
        fail(error);
        completed.push(pending);
      }
    }
  } catch {
    // A network failure may have committed. Do not claim rollback or blind retry safety.
    return NextResponse.json({ success: false, error: 'Batch stopped; inspect completed operations and verify the uncertain operation before retrying',
      atomic: false, matched_count: ids.length, completed, uncertain_operation: pending }, { status: 500 });
  }
  return NextResponse.json({ success: true, dry_run: false, atomic: false, matched_count: ids.length, completed });
}