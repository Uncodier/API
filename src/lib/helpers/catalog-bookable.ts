import { supabaseAdmin } from '@/lib/database/supabase-client';

export type BookableParent = {
  id: string;
  name?: string;
  status?: string | null;
  availability_status?: string | null;
};

export type BookableCatalogItem = {
  id: string;
  name?: string;
  status?: string | null;
  availability_status?: string | null;
  parent_id?: string | null;
  parent?: BookableParent | BookableParent[] | null;
};

export function isRowBookable(status?: string | null, availabilityStatus?: string | null): boolean {
  return status === 'active' && availabilityStatus === 'available';
}

function asParent(value: BookableCatalogItem['parent']): BookableParent | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] || null;
  return value;
}

/**
 * An item is bookable only if it AND its parent are active + available.
 * Missing parent while parent_id is set fails closed.
 */
export function isItemBookable(item: BookableCatalogItem): boolean {
  if (!isRowBookable(item.status, item.availability_status)) return false;
  if (!item.parent_id) return true;
  const parent = asParent(item.parent);
  if (!parent) return false;
  return isRowBookable(parent.status, parent.availability_status);
}

/** Filter using parents already present in the same collection (calendars). */
export function filterBookableFamily<T extends BookableCatalogItem>(items: T[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return items.filter((item) => {
    if (!isRowBookable(item.status, item.availability_status)) return false;
    if (!item.parent_id) return true;
    const parent = byId.get(item.parent_id) || asParent(item.parent);
    if (!parent) return false;
    return isRowBookable(parent.status, parent.availability_status);
  });
}

export async function loadUnbookableParentIds(siteId?: string): Promise<string[]> {
  let query = supabaseAdmin
    .from('catalog_items')
    .select('id')
    .or('status.neq.active,availability_status.neq.available');
  if (siteId) query = query.eq('site_id', siteId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []).map((row) => row.id);
}

export async function loadParentForBookableCheck(parentId: string): Promise<BookableParent | null> {
  const { data } = await supabaseAdmin
    .from('catalog_items')
    .select('id, name, status, availability_status')
    .eq('id', parentId)
    .maybeSingle();
  return data || null;
}

export async function assertCatalogItemBookable(catalogItemId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('catalog_items')
    .select('id, name, status, availability_status, parent_id')
    .eq('id', catalogItemId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`Catalog item not found: ${catalogItemId}`);
  }

  const parent = data.parent_id ? await loadParentForBookableCheck(data.parent_id) : null;
  if (!isItemBookable({ ...data, parent })) {
    throw new Error(`Catalog item ${data.name || catalogItemId} or its parent is archived or unavailable`);
  }
}
