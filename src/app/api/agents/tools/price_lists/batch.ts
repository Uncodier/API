import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin as db } from '@/lib/database/supabase-client';
import type { PriceListBatchInput } from './batch-schema';

const chunks = <T>(rows: T[]) => Array.from({ length: Math.ceil(rows.length / 100) }, (_, i) => rows.slice(i * 100, i * 100 + 100));
function fail(error: { message: string } | null) { if (error) throw new Error('Price-list database operation failed'); }
async function assertReferences(table: string, ids: string[], siteId: string) {
  for (const chunk of chunks([...new Set(ids)])) {
    const { data, error } = await db.from(table).select('id').eq('site_id', siteId).in('id', chunk);
    fail(error);
    const found = new Set(data?.map(row => row.id));
    if (chunk.some(id => !found.has(id))) throw new Error(`Unknown or foreign-site ${table} reference`);
  }
}
type Operation = { operation: string; price_list_ids: string[]; catalog_item_ids?: string[] };

/** Authorized administrative callers only. Each write is atomic, not the request. */
export async function handlePriceListBatch(input: PriceListBatchInput) {
  const updates = input.updates || (input.price_list_ids || []).map(id => ({ id, changes: input.changes, items: input.items }));
  const matchedCount = input.action === 'batch_create' ? input.lists!.length : updates.length;
  const ids = updates.map(row => row.id);
  if (input.expected_count !== undefined && input.expected_count !== matchedCount) {
    return NextResponse.json({ success: false, error: 'Selection count changed; preview again', matched_count: matchedCount }, { status: 409 });
  }
  try {
    if (input.action === 'batch_update') await assertReferences('price_lists', ids, input.site_id);
    const catalogIds = input.action === 'batch_create'
      ? input.lists!.flatMap(row => row.items?.map(item => item.catalog_item_id) || [])
      : updates.flatMap(row => [...(row.items?.set?.map(item => item.catalog_item_id) || []), ...(row.items?.remove || [])]);
    await assertReferences('catalog_items', catalogIds, input.site_id);
    // Guard legacy inconsistent rows before upsert (the conflict key excludes site_id).
    for (const row of updates) {
      const itemIds = [...(row.items?.set?.map(item => item.catalog_item_id) || []), ...(row.items?.remove || [])];
      for (const chunk of chunks(itemIds)) {
        const { data, error } = await db.from('price_list_items').select('site_id')
          .eq('price_list_id', row.id).in('catalog_item_id', chunk);
        fail(error);
        if (data?.some(item => item.site_id !== input.site_id)) throw new Error('Price-list item tenant mismatch');
      }
    }
  } catch {
    return NextResponse.json({ success: false, error: 'Price-list preflight failed: verify site-owned list/item references and database availability; no writes started' }, { status: 400 });
  }
  if (input.dry_run) return NextResponse.json({
    success: true, dry_run: true, matched_count: matchedCount, price_list_ids: ids,
    ...(input.action === 'batch_create' ? { lists: input.lists } : { updates }),
  });

  const completed: Operation[] = [];
  let pending: Operation | undefined;
  const created: { index: number; id: string }[] = [];
  try {
    const timestamp = new Date().toISOString();
    const writeItems = async (id: string, items: { catalog_item_id: string; unit_price: number }[]) => {
      for (const chunk of chunks(items)) {
        pending = { operation: 'items_set', price_list_ids: [id], catalog_item_ids: chunk.map(row => row.catalog_item_id) };
        const { error } = await db.from('price_list_items').upsert(chunk.map(row => ({
          ...row, site_id: input.site_id, price_list_id: id, updated_at: timestamp,
        })), { onConflict: 'price_list_id,catalog_item_id' });
        fail(error);
        completed.push(pending);
      }
    };
    if (input.action === 'batch_create') {
      const rows = input.lists!.map((row, index) => ({ ...row, id: randomUUID(), index }));
      for (const chunk of chunks(rows)) {
        pending = { operation: 'lists_create', price_list_ids: chunk.map(row => row.id) };
        const { data, error } = await db.from('price_lists').insert(chunk.map(({ items: _items, index: _index, ...row }) => ({
          is_default: false, is_active: true, channels: ['pos'], ...row, site_id: input.site_id, updated_at: timestamp,
        }))).select('id');
        fail(error);
        completed.push({ ...pending, price_list_ids: (data || []).map(row => row.id) });
        created.push(...chunk.map(row => ({ index: row.index, id: row.id })));
        if (data?.length !== chunk.length) throw new Error('Unexpected inserted list count');
        for (const row of chunk) await writeItems(row.id, row.items || []);
      }
    } else {
      // Common patches use set-based chunks; heterogeneous patches retain explicit per-list boundaries.
      const groups = input.updates ? updates.map(row => [row]) : chunks(updates);
      for (const group of groups) {
        const changes = group[0].changes;
        const groupIds = group.map(row => row.id);
        if (Object.keys(changes || {}).length) {
          pending = { operation: 'lists_update', price_list_ids: groupIds };
          const { data, error } = await db.from('price_lists').update({ ...changes, updated_at: timestamp })
            .eq('site_id', input.site_id).in('id', groupIds).select('id');
          fail(error);
          completed.push({ ...pending, price_list_ids: (data || []).map(row => row.id) });
          if (data?.length !== groupIds.length) throw new Error('Selection changed during execution');
        }
        for (const row of group) {
          await writeItems(row.id, row.items?.set || []);
          for (const chunk of chunks(row.items?.remove || [])) {
            pending = { operation: 'items_remove', price_list_ids: [row.id], catalog_item_ids: chunk };
            const { error } = await db.from('price_list_items').delete().eq('site_id', input.site_id)
              .eq('price_list_id', row.id).in('catalog_item_id', chunk);
            fail(error);
            completed.push(pending);
          }
        }
      }
    }
  } catch {
    return NextResponse.json({ success: false, atomic: false, matched_count: matchedCount, created,
      error: 'Batch stopped; inspect completed operations and verify the uncertain operation before retrying',
      completed, uncertain_operation: pending }, { status: 500 });
  }
  return NextResponse.json({ success: true, dry_run: false, atomic: false, matched_count: matchedCount, completed, created });
}