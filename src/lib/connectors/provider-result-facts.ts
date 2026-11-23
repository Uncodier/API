import { TABLE_TOOL } from './supabase-table-policy';
import { projectTableNames } from './supabase-table-result';
import { ConnectorError } from './types';

/** Outbound chat may be visible to other workspace members. Only release typed
 * facts, not arbitrary provider records, labels, diagnostics or cursors. */
export function providerResultFacts(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const facts: Partial<Record<'count' | 'total' | 'total_count', number> & { has_more: boolean }> = {};
  for (const key of ['count', 'total', 'total_count', 'has_more'] as const) {
    const field = Object.getOwnPropertyDescriptor(data, key);
    if (!field || !('value' in field)) continue;
    const value: unknown = field.value;
    if (key === 'has_more') {
      if (typeof value === 'boolean') facts[key] = value;
    } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      facts[key] = value;
    }
  }
  return Object.keys(facts).length ? facts : undefined;
}

export function askProviderResult(toolkit: string, slug: string, data: unknown) {
  if (toolkit !== 'supabase' || slug !== TABLE_TOOL) return providerResultFacts(data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  try {
    // Direct listing can include views, unlike the reviewed tables-only path.
    const { tables, coverage } = projectTableNames(data as Record<string, unknown>, { excludeViews: true });
    return { returned_count: tables.length, coverage };
  } catch (error) {
    // Do not turn an unsupported inventory into zero or infer its size from
    // other provider fields. This does not affect optional private record storage.
    if (!(error instanceof ConnectorError) || error.code !== 'CONNECTOR_OUTCOME_UNKNOWN') throw error;
  }
}