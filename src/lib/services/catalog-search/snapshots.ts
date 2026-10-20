import { z } from 'zod';
import { candidateSchema, CATALOG_CANDIDATE_LIMIT, CATALOG_RELATED_LIMIT } from './contract';
import { catalogCacheKey, readCatalogCache, writeCatalogCache } from './cache';
import { catalogDegradationReasonSchema } from './semantic-errors';

export const snapshotSchema = z.object({
  binding: z.string(), expiresAt: z.number().int(),
  candidates: z.array(candidateSchema).max(CATALOG_CANDIDATE_LIMIT),
  mode: z.enum(['text', 'hybrid']), degraded: z.boolean(),
  candidate_window_truncated: z.boolean().optional(),
  result_kind: z.enum(['matched', 'related']).default('matched'),
  degradationReason: catalogDegradationReasonSchema.optional(),
}).refine(snapshot => snapshot.result_kind !== 'related' || (snapshot.candidates.length <= CATALOG_RELATED_LIMIT
  && snapshot.mode === 'hybrid' && !snapshot.degraded && !snapshot.candidate_window_truncated));
export type CatalogSnapshot = z.infer<typeof snapshotSchema>;
export const SNAPSHOT_LIFETIME_MS = 120_000;
const localSnapshots = new Map<string, CatalogSnapshot>();

function snapshotKey(id: string, binding: string) { return catalogCacheKey('snapshot', { id, binding }); }

/** Bounded local fallback; cross-instance continuity uses Redis, never a new ranking. */
export async function readCatalogSnapshot(id: string, binding: string): Promise<CatalogSnapshot | null> {
  const key = snapshotKey(id, binding);
  const local = localSnapshots.get(key);
  if (local && local.expiresAt > Date.now()) return local;
  localSnapshots.delete(key);
  const parsed = snapshotSchema.safeParse(await readCatalogCache(key));
  if (!parsed.success || parsed.data.binding !== binding || parsed.data.expiresAt <= Date.now()) return null;
  return parsed.data;
}

export async function saveCatalogSnapshot(id: string, rawSnapshot: z.input<typeof snapshotSchema>): Promise<void> {
  const snapshot = snapshotSchema.parse(rawSnapshot);
  const key = snapshotKey(id, snapshot.binding);
  for (const [storedKey, value] of localSnapshots) {
    if (value.expiresAt <= Date.now()) localSnapshots.delete(storedKey);
  }
  if (localSnapshots.size >= 128) localSnapshots.delete(localSnapshots.keys().next().value!);
  localSnapshots.set(key, snapshot);
  await writeCatalogCache(key, snapshot, Math.ceil((snapshot.expiresAt - Date.now()) / 1000));
}