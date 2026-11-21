import { createHash } from 'node:crypto';
import type { AnalyticsDataset } from './supabase-select-types';
import { nativeSources } from './supabase-analytics-native';
import { isBoundSupabaseProject } from './supabase-table-policy';
import { ConnectorError, type Connector } from './types';

export type AnalyticsScope = 'workspace' | 'platform';
export type BoundDataset = AnalyticsDataset & { readonly kind: 'native' | 'external'; readonly allowRows?: true };
const nativeHelp = 'paid_sales = current completed sales with zero recorded amount due; amount is gross face value in major units, sale_date is not a payment date. '
  + 'tender_awards = materialized awards at winning quotation values. approved_orders = materialized approved purchase orders. Both use creation time and net/tax minor units; separate stages, not additive. '
  + 'Procurement requires unrestricted workspace owner/admin. COUNT(DISTINCT site_id) counts participating sites. Group money by currency; no FX, cash ledger or historical paid-state reconstruction.';
export type AnalyticsCapability =
  | { status: 'ready'; dataset: BoundDataset }
  | { status: 'unverified' | 'unmapped' | 'unavailable' };

/** Never derive installation identity from the connected account. Recheck mutable external mappings for dispatch and delivery. */
export async function resolveAnalyticsCapability(connector: Connector, localRef: string | undefined): Promise<AnalyticsCapability> {
  if (!isBoundSupabaseProject(connector) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(connector.site_id) ||
    connector.site_id.length !== 36 || connector.enabled !== true || !connector.verified_at || connector.provider_status !== 'ACTIVE' ||
    connector.revocation_pending !== false || connector.revocation_dispatched === true) {
    throw new ConnectorError('CONNECTOR_PROJECT_UNBOUND', 'An active verified Supabase connector and project binding are required.', 409);
  }
  if (!localRef || localRef.length !== 20 || !/^[a-z]{20}$/.test(localRef)) return { status: 'unverified' };
  if (localRef === connector.supabase_project_ref) {
    return { status: 'ready', dataset: { kind: 'native', sources: nativeSources('workspace'), parameters: [connector.site_id], allowRows: true } };
  }
  try {
    const { loadExternalDataset } = await import('./supabase-analytics-registry');
    const mapped = await loadExternalDataset(connector);
    return mapped ? { status: 'ready', dataset: { ...mapped, kind: 'external', allowRows: true } } : { status: 'unmapped' };
  } catch (error) {
    if (error instanceof ConnectorError && error.code === 'CATALOG_AUTHORIZATION_UNAVAILABLE') return { status: 'unavailable' };
    throw error;
  }
}

export function scopedDataset(capability: AnalyticsCapability, scope: AnalyticsScope): BoundDataset {
  if (capability.status !== 'ready') {
    if (capability.status !== 'unmapped') throw new ConnectorError('CATALOG_AUTHORIZATION_UNAVAILABLE', 'The installation or analytics registry could not be verified.', 503);
    throw new ConnectorError('SUPABASE_DATASET_UNAVAILABLE', 'No analytics sources are registered for this project and workspace.', 409);
  }
  if (scope === 'workspace') return capability.dataset;
  if (scope !== 'platform' || capability.dataset.kind !== 'native') throw new ConnectorError('ANALYTICS_WORKSPACE_ONLY', 'External analytics mappings are workspace-only.', 403);
  return { kind: 'native', sources: nativeSources('platform'), parameters: [] };
}

/** Only logical vocabulary. Never expose physical mappings, SQL, site IDs or bound parameter values. */
export function analyticsSourceHelp(dataset: BoundDataset): string {
  const vocabulary = Object.entries(dataset.sources).map(([name, s]) =>
      `${name}(${Object.entries(s.columns).map(([c,type]) => `${c}:${type}`).join(', ')})` +
      (s.money ? `: report ${s.money.measures.join('/')} by ${s.money.currency}` : '')).join('; ');
  return `${vocabulary}. ` + (dataset.kind === 'native' ? `${nativeHelp} Workspace is the default; bounded projections exclude IDs. Platform scope is aggregate only and needs a separate operator grant.` : 'Operator-mapped facts, bounded non-ID projections in workspace scope only.');
}

/** Pin the operator mapping even when two different physical policies publish identical logical names/types. */
export function analyticsDatasetFingerprint({ sources, kind, allowRows }: BoundDataset): string {
  return createHash('sha256').update(JSON.stringify({ profile: 'analytics-v1', kind, allowRows, sources })).digest('hex');
}
