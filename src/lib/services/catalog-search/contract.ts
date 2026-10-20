import { z } from 'zod';

export const CATALOG_MODEL = 'openai/text-embedding-3-small';
export const CATALOG_DIMENSIONS = 1536;
export const CATALOG_CANDIDATE_LIMIT = 200;
export const CATALOG_RETRIEVER_PROBE_LIMIT = CATALOG_CANDIDATE_LIMIT + 1;
export const CATALOG_SEARCH_VERSION = 'v3-related';
export const CATALOG_MIN_SIMILARITY = 0.35;
export const CATALOG_RELATED_MIN_SIMILARITY = 0.25;
export const CATALOG_RELATED_LIMIT = 5;

export const catalogFiltersSchema = z.object({
  kind: z.enum(['product', 'service', 'digital_asset', 'variant']).optional(),
  digital_subtype: z.string().trim().min(1).max(80).optional(),
  category_id: z.string().uuid().nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
  availability_status: z.enum(['available', 'unavailable', 'sold_out']).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  is_reservation: z.boolean().optional(),
  is_purchasable: z.boolean().optional(),
  is_recurring: z.boolean().optional(),
  is_pos_available: z.boolean().optional(),
  is_marketplace_listed: z.boolean().optional(),
}).strict();

export const catalogSearchSchema = z.object({
  query: z.string().trim().min(1).max(200),
  channel: z.enum(['tools', 'shop', 'marketplace', 'catalog', 'pos']),
  site_id: z.string().uuid().optional(),
  filters: catalogFiltersSchema.default({}),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(CATALOG_CANDIDATE_LIMIT).default(0),
  search_id: z.string().uuid().optional(),
}).strict().superRefine((input, ctx) => {
  if (input.channel !== 'marketplace' && !input.site_id) {
    ctx.addIssue({ code: 'custom', path: ['site_id'], message: 'This channel requires site_id' });
  }
});

export type CatalogSearchInput = z.infer<typeof catalogSearchSchema>;
export type CatalogPrincipal = { scope: string; rateIdentity?: string; service?: boolean; aggregateOnly?: boolean };
export const candidateSchema = z.object({
  id: z.string().uuid(), site_id: z.string().uuid(),
  score: z.number().finite(), exact_match: z.boolean(),
});
export type CatalogCandidate = z.infer<typeof candidateSchema>;
export type CatalogSearchResult = {
  success: true;
  items: Array<{ id: string; site_id: string }>;
  count: number;
  count_kind: 'candidate_window';
  candidate_window_truncated?: boolean;
  result_kind?: 'matched' | 'related';
  has_more: boolean;
  mode: 'hybrid' | 'text';
  degraded: boolean;
  search_id: string;
};

/** Keep punctuation, accents and meaningful words; do not rewrite user intent. */
export function normalizeCatalogQuery(query: string): string {
  return query.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Stable JSON for keys: filter insertion order must not fragment caches. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter(key => object[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Deduplicate before any window cap so overlap cannot manufacture overflow. */
export function fuseCatalogCandidates(text: CatalogCandidate[], semantic: CatalogCandidate[]): CatalogCandidate[] {
  const merged = new Map<string, CatalogCandidate>();
  for (const list of [text, semantic]) {
    list.forEach((item, index) => {
      const previous = merged.get(item.id);
      merged.set(item.id, {
        ...item, score: (previous?.score || 0) + 1 / (60 + index + 1),
        exact_match: item.exact_match || Boolean(previous?.exact_match),
      });
    });
  }
  return [...merged.values()].sort((a, b) => Number(b.exact_match) - Number(a.exact_match)
    || b.score - a.score || a.id.localeCompare(b.id));
}