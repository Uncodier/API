import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isItemBookable, type BookableCatalogItem } from '@/lib/helpers/catalog-bookable';
import { scopeCatalogItemPromptImage } from '@/lib/services/catalog-prompt-image-url';
import { searchCatalog } from '@/lib/services/catalog-search/service';
import {
  catalogFiltersSchema, catalogSearchSchema,
  type CatalogPrincipal, type CatalogSearchInput,
} from '@/lib/services/catalog-search/contract';

export const itemListSchema = z.object({
  site_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 100).default(0),
  search: z.string().optional(),
});

const SEARCH_FIELDS = [
  'id', 'site_id', 'name', 'description', 'sku', 'kind', 'digital_subtype',
  'category_id', 'parent_id', 'target_sale_price', 'currency', 'status',
  'availability_status', 'image_url', 'is_marketplace_listed', 'is_reservation',
  'is_purchasable', 'is_recurring', 'is_pos_available', 'pass_uses', 'pass_validity_days',
] as const;
export const CATALOG_LIST_FIELDS = SEARCH_FIELDS.join(',');

const liveItemsSchema = z.array(z.object({
  id: z.string(), site_id: z.string(), name: z.string().nullable().optional(),
  status: z.string().nullable().optional(), availability_status: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
}).passthrough()).max(100);

export function createCatalogToolSearchInput(body: Record<string, unknown>): CatalogSearchInput {
  const list = itemListSchema.parse(body);
  const filters = Object.fromEntries(Object.keys(catalogFiltersSchema.shape)
    .filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  return catalogSearchSchema.parse({
    query: list.search, channel: 'tools', site_id: list.site_id,
    filters, limit: list.limit, offset: list.offset, search_id: body.search_id,
  });
}

export function compactCatalogListItem(row: Record<string, unknown>) {
  // Allowlist again after hydration: never expose cost, private metadata or index fields.
  const item = Object.fromEntries(SEARCH_FIELDS.filter(key => row[key] !== undefined)
    .map(key => [key, row[key]]));
  if (typeof item.description === 'string' && item.description.length > 320) {
    item.description = `${item.description.slice(0, 319)}…`;
  }
  for (const [key, max] of [['name', 240], ['sku', 128]] as const) {
    if (typeof item[key] === 'string' && item[key].length > max) {
      item[key] = `${item[key].slice(0, max - 1)}…`;
    }
  }
  // Do not emit a truncated, invalid URL or permit an oversized image prompt into context.
  if (typeof item.image_url === 'string' && item.image_url.length > 2_048) item.image_url = null;
  return scopeCatalogItemPromptImage(item);
}

export function compactCatalogListItems(rows: unknown) {
  return liveItemsSchema.parse(rows || []).map(compactCatalogListItem);
}

/** Only trusted server callers may supply a principal; the HTTP route authorizes it first. */
export async function searchToolItems(body: Record<string, unknown>, principal?: CatalogPrincipal) {
  const input = createCatalogToolSearchInput(body);
  const siteId = input.site_id!; // Required by both schemas for channel=tools.
  const result = await searchCatalog(input, principal ?? { scope: `site:${siteId}:tools` });
  const ids = [...new Set(result.items.filter(item => item.site_id === siteId).map(item => item.id))];
  if (!ids.length) return { ...result, items: [] };

  let query = supabaseAdmin.from('catalog_items').select(CATALOG_LIST_FIELDS)
    .eq('site_id', siteId).in('id', ids);
  for (const [key, value] of Object.entries(input.filters)) {
    if (key === 'kind' && value === 'variant') query = query.not('parent_id', 'is', null);
    else if (value === null) query = query.is(key, null);
    else {
      query = query.eq(key, value);
    }
  }
  const enforceBookable = !input.filters.status && !input.filters.availability_status;
  if (enforceBookable) query = query.eq('status', 'active').eq('availability_status', 'available');
  const { data, error } = await query;
  if (error) throw new Error('Catalog item details unavailable');

  const rows = liveItemsSchema.parse(data || []);
  const parentIds = [...new Set(rows.filter(row => row.site_id === siteId && row.parent_id)
    .map(row => row.parent_id!))];
  const parents = new Map<string, BookableCatalogItem>();
  if (enforceBookable && parentIds.length) {
    // Bound the parent check to this page rather than reading all unavailable catalog rows.
    const { data: parentRows, error: parentError } = await supabaseAdmin.from('catalog_items')
      .select('id,status,availability_status').eq('site_id', siteId).in('id', parentIds);
    if (parentError) throw new Error('Catalog parent availability unavailable');
    for (const parent of parentRows || []) parents.set(parent.id, parent);
  }
  const byId = new Map(rows.filter(row => row.site_id === siteId
    && (!enforceBookable || isItemBookable({ ...row, parent: parents.get(row.parent_id!) })))
    .map(row => [row.id, row]));
  // SQL hydration need not return rank order. Missing/changed rows fail closed.
  return { ...result, items: ids.flatMap(id => byId.has(id) ? [compactCatalogListItem(byId.get(id)!)] : []) };
}
