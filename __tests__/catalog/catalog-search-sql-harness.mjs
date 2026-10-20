import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

export const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const model = 'openai/text-embedding-3-small';
export const embedding = Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0);
const root = new URL('../../', import.meta.url);
export const names = ['catalog_search_documents', 'catalog_search_refresh', 'catalog_embedding_outbox', 'catalog_search_candidates', 'catalog_search_repairs', 'catalog_search_parameter_permissions'];

export const vectorSubstitutes = `
  CREATE FUNCTION public.vector_dims(double precision[]) RETURNS integer
    LANGUAGE sql IMMUTABLE AS 'SELECT cardinality($1)';
  CREATE FUNCTION public.test_vector_distance(double precision[], double precision[]) RETURNS double precision
    LANGUAGE sql IMMUTABLE AS $$ SELECT 1 - sum(a*b)/sqrt(sum(a*a)*sum(b*b)) FROM unnest($1,$2) x(a,b) $$;
  CREATE FUNCTION public.test_vector_dot(double precision[], double precision[]) RETURNS double precision
    LANGUAGE sql IMMUTABLE AS $$ SELECT -sum(a*b) FROM unnest($1,$2) x(a,b) $$;
  CREATE OPERATOR public.<=> (LEFTARG=double precision[], RIGHTARG=double precision[], FUNCTION=public.test_vector_distance);
  CREATE OPERATOR public.<#> (LEFTARG=double precision[], RIGHTARG=double precision[], FUNCTION=public.test_vector_dot);
`;
export function migrationSql(i) {
  const original = readFileSync(new URL(`supabase/migrations/20261020010${i}00_${names[i]}.sql`, root), 'utf8');
  assert.ok(original.includes('BEGIN;') && original.includes('COMMIT;'));
  return original.replace('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;', '')
    .replace(/CREATE INDEX catalog_search_documents_vector_idx[\s\S]*?embedding_source_hash = source_hash;/, '')
    .replace(/\bvector\(1536\)/g, 'double precision[]')
    .replace(/\bvector(?=,|\))/g, 'double precision[]');
}

export async function setup() {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(readFileSync(new URL('./catalog-search-fixture.sql', import.meta.url), 'utf8'));
  // PGlite has real pg_trgm and FTS, but this installation has no pgvector.
  // Substitute ONLY vector storage/math/index and extension availability guard.
  // SQL state machines, permissions, triggers, all retrieval predicates run unchanged.
  await db.exec(vectorSubstitutes);
  // A genuinely preexisting row must be searchable without migration backfill.
  await db.query('INSERT INTO sites VALUES ($1, $2, NULL), ($3, $4, NULL)', [id(1), 'North', id(2), 'South']);
  await db.query('INSERT INTO catalog_items(id,site_id,name,sku) VALUES ($1,$2,$3,$4)',
    [id(10), id(1), 'Legacy guitar', 'LEGACY']);
  for (const i of names.keys()) await db.exec(migrationSql(i));
  return db;
}

export async function rows(db, sql, args = []) { return (await db.query(sql, args)).rows; }
export async function one(db, sql, args = []) { return (await rows(db, sql, args))[0]; }
export async function scalar(db, sql, args = []) { return Object.values(await one(db, sql, args))[0]; }
export async function asRole(db, role, fn) {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec('RESET ROLE'); }
}
export async function addItem(db, n, fields = {}) {
  const values = { id: id(n), site_id: id(1), name: `Guitar ${n}`, ...fields };
  await db.query(`INSERT INTO catalog_items(${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map((_, i) => `$${i + 1}`).join(',')})`, Object.values(values));
  return id(n);
}
export async function search(db, query, { site = id(1), channel = 'tools', filters = {}, mode = 'text', vector = null, limit = 200, minSimilarity = 0.35 } = {}) {
  return asRole(db, 'service_role', () => rows(db,
    'SELECT * FROM catalog_search_candidates($1,$2,$3,$4,$5,$6,$7,$8)', [site, channel, query, filters, mode, vector, limit, minSimilarity]));
}
export async function claim(db, limit = 100) {
  return asRole(db, 'service_role', () => rows(db, 'SELECT * FROM claim_catalog_embedding_jobs($1,180)', [limit]));
}
export async function complete(db, job, override = {}) {
  const j = { ...job, ...override };
  return asRole(db, 'service_role', () => scalar(db, 'SELECT complete_catalog_embedding_job($1,$2,$3,$4,$5,$6)',
    [j.id, j.claim_token, j.source_hash, j.source_revision, override.embedding ?? embedding, override.model ?? model]));
}
export async function revisionToken(db, scope = 'public') {
  return asRole(db, 'service_role', () => scalar(db, 'SELECT catalog_search_revision($1)', [scope === 'public' ? null : scope]));
}
export async function revision(db, scope = 'public') {
  return BigInt((await revisionToken(db, scope)).split(':')[1]);
}
export async function drain(db) {
  return scalar(db, 'SELECT catalog_search_drain_refresh_events(500)');
}