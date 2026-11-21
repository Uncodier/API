import { createHash } from 'node:crypto';
import { getSupabaseServiceRoleUrl } from '@/lib/database/supabase-client';
import type { AnalyticsDataset } from './supabase-select-types';
import { nativeSources } from './supabase-analytics-native';
import { externalDataset } from './supabase-analytics-external';
import { isBoundSupabaseProject } from './supabase-table-policy';
import { ConnectorError, type Connector } from './types';

export type AnalyticsScope = 'workspace' | 'platform';
export type BoundDataset = AnalyticsDataset & { readonly kind: 'native' | 'external'; readonly allowRows?: true };
const nativeHelp = 'paid_sales = current completed sales with zero recorded amount due; amount is gross face value in major units, sale_date is not a payment date. '
  + 'tender_awards = materialized awards at winning quotation values. approved_orders = materialized approved purchase orders. Both use creation time and net/tax minor units; separate stages, not additive. '
  + 'Procurement requires unrestricted workspace owner/admin. COUNT(DISTINCT site_id) counts participating sites. Group money by currency; no FX, cash ledger or historical paid-state reconstruction.';
function unavailable(): never {
  throw new ConnectorError('SUPABASE_DATASET_UNAVAILABLE', 'No trusted direct analytics dataset is configured for this bound project and workspace. Verify the operator mapping or use a deliberately published report.', 409);
}

function verifiedLocalOrigin(ref: string) {
  const configured = getSupabaseServiceRoleUrl();
  if (configured === `https://${ref}.supabase.co` || configured === `https://${ref}.supabase.co/`) return true;
  // Custom domains are not project refs. Require an independent deployment attestation for the
  // *actual* service-role origin; never reinterpret another hosted project's canonical URL.
  const domain = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/?$/.exec(configured);
  if (!domain || domain[1].endsWith('.supabase.co') || domain[1].endsWith('.supabase.in')) return false;
  return process.env.CONNECTOR_ANALYTICS_LOCAL_BINDING === `https://${domain[1]}=${ref}`;
}

/** The caller supplies an authorized connector row, never a model-provided identity or URL. */
export function getSupabaseAnalyticsDataset(connector: Connector, scope: AnalyticsScope = 'workspace'): BoundDataset {
  if (!isBoundSupabaseProject(connector) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(connector.site_id) ||
    connector.site_id.length !== 36 || connector.enabled !== true || !connector.verified_at || connector.provider_status !== 'ACTIVE' ||
    connector.revocation_pending !== false || connector.revocation_dispatched === true) {
    throw new ConnectorError('CONNECTOR_PROJECT_UNBOUND', 'An active verified Supabase connector and project binding are required.', 409);
  }
  if (scope !== 'workspace' && scope !== 'platform') unavailable();
  const ref = connector.supabase_project_ref!;
  // One effective authorization DB. Do not fall back to a second URL when this one does not match.
  if (!verifiedLocalOrigin(ref)) {
    const mapped = externalDataset(ref, connector.site_id);
    if (!mapped) unavailable();
    if (scope !== 'workspace') throw new ConnectorError('ANALYTICS_WORKSPACE_ONLY', 'External analytics mappings are workspace-only.', 403);
    return { ...mapped, kind: 'external', allowRows:true };
  }
  return { sources: nativeSources(scope), kind: 'native', parameters: scope==='workspace' ? [connector.site_id] : [],
    ...(scope==='workspace' && { allowRows:true as const }) };
}

/** Only logical vocabulary. Never expose physical mappings, SQL, site IDs or bound parameter values. */
export function analyticsSourceHelp(connector: Connector): string | null {
  try {
    const dataset = getSupabaseAnalyticsDataset(connector);
    const vocabulary = Object.entries(dataset.sources).map(([name, s]) =>
      `${name}(${Object.entries(s.columns).map(([c,type]) => `${c}:${type}`).join(', ')})` +
      (s.money ? `: report ${s.money.measures.join('/')} by ${s.money.currency}` : '')).join('; ');
    return `${vocabulary}. ` + (dataset.kind === 'native' ? `${nativeHelp} Workspace is the default; bounded projections exclude IDs. Platform scope is aggregate only and needs a separate operator grant.` : 'Operator-mapped facts, bounded non-ID projections in workspace scope only.');
  } catch (e) {
    if (e instanceof ConnectorError && ['SUPABASE_DATASET_UNAVAILABLE', 'CONNECTOR_PROJECT_UNBOUND'].includes(e.code)) return null;
    throw e;
  }
}

/** Pin the operator mapping even when two different physical policies publish identical logical names/types. */
export function analyticsDatasetFingerprint(connector: Connector): string {
  const { sources, kind, allowRows } = getSupabaseAnalyticsDataset(connector);
  return createHash('sha256').update(JSON.stringify({ profile: 'analytics-v1', kind, allowRows, sources })).digest('hex');
}
