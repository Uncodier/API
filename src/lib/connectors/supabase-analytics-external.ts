import { NATIVE_SOURCE_NAMES } from './supabase-analytics-native';
import { baseGuard } from './supabase-analytics-guards';
import { z } from 'zod';
import type { AnalyticsColumnType, AnalyticsDataset, AnalyticsSource } from './supabase-select-types';

// Server deployment policy only. No caller input, SQL fragments, paths, connection strings or views.
// An operator must verify the external tenant key stores Makinari site UUIDs and each published
// field is an appropriate analytical fact. Restrict categorical strings to pre-reviewed labels.
const name = z.string().min(1).max(48).regex(/^[a-z][a-z0-9_]*$/).refine(v =>
  !/[^a-z0-9_]/.test(v) && !v.startsWith('pg_') && !Object.hasOwn(Object.prototype,v) && v !== 'prototype');
const primitive = z.enum(['numeric','integer','date','timestamptz','boolean']);
const token = z.string().min(1).max(24).regex(/^[A-Za-z][A-Za-z0-9_-]*$/).refine(v => v !== 'NULL' && !/[^A-Za-z0-9_-]/.test(v));
const field = z.object({ name, column: name });
const columns = z.array(z.union([field.extend({ type: primitive }).strict(),
  field.extend({ type: z.literal('text'), values: z.array(token).min(1).max(32) }).strict()])).min(1).max(12);
const definition = z.object({ name, schema: name.refine(v => v.startsWith('makinari_facts_')), table: name,
  siteColumn: name, columns, money:z.object({currency:name, measures:z.array(name).min(1).max(12)}).strict().optional() }).strict();
const policies = z.array(z.object({ projectRef: z.string().length(20).regex(/^[a-z]{20}$/), siteId: z.string().uuid(),
  sources: z.array(definition).min(1).max(8) }).strict()).max(64);
const namesUnique = (a: string[]) => new Set(a).size === a.length;

export function externalDataset(ref: string, site: string): AnalyticsDataset | null {
  const json = process.env.CONNECTOR_ANALYTICS_EXTERNAL_DATASETS;
  if (!json || Buffer.byteLength(json) > 65_536) return null;
  let value: unknown;
  try { value = JSON.parse(json); } catch { return null; }
  const parsed = policies.safeParse(value);
  if (!parsed.success) return null;
  const matches = parsed.data.filter(p => p.projectRef === ref && p.siteId === site);
  if (matches.length !== 1 || !namesUnique(matches[0].sources.map(s => s.name))) return null;
  const sources: Record<string, AnalyticsSource> = Object.create(null);
  for (const d of matches[0].sources) {
    if (NATIVE_SOURCE_NAMES.has(d.name)) return null; // Never borrow native semantics or document labels for external facts.
    if (!namesUnique(['site_id', ...d.columns.map(c => c.name)]) || !namesUnique([d.siteColumn, ...d.columns.map(c => c.column)])) return null;
    if (d.money) {
      const currency = d.columns.find(c=>c.name===d.money!.currency);
      if (currency?.type !== 'text' || !currency.values.every(v=>/^[A-Z]{3}$/.test(v)) || !namesUnique(d.money.measures) ||
        !d.money.measures.every(m=>d.columns.some(c=>c.name===m && (c.type==='integer' || c.type==='numeric')))) return null;
    }
    const relation = `"${d.schema}"."${d.table}"`;
    const columns: Record<string, AnalyticsColumnType> = { site_id: 'uuid' };
    const select = [`f."${d.siteColumn}" AS "site_id"`];
    const physical: Record<string,AnalyticsColumnType> = { [d.siteColumn]:'uuid' };
    for (const c of d.columns) {
      columns[c.name] = c.type; physical[c.column] = c.type;
      const col = `f."${c.column}"`;
      select.push((c.type === 'text' ? `CASE WHEN ${col} COLLATE pg_catalog."C" IN (${c.values.map(v=>`'${v}'`).join(',')}) THEN ${col} END` : col) + ` AS "${c.name}"`);
    }
    // Ordinary base tables only; exclude children (FROM ONLY) and active RLS (a false zero
    // under the management role cannot attest the requested scope). Resolve and check every type.
    sources[d.name] = { columns, ...(d.money && {money:d.money}), sql:`SELECT ${select.join(', ')} FROM ONLY ${relation} AS f WHERE f."${d.siteColumn}" = $1::pg_catalog.uuid`,
      guardSql: baseGuard(d.schema,d.table,physical) };
  }
  return { sources, parameters: [site] };
}
