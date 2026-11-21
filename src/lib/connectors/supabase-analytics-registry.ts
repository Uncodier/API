import 'server-only';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { externalDataset } from './supabase-analytics-external';
import type { AnalyticsDataset } from './supabase-select-types';
import { isBoundSupabaseProject } from './supabase-table-policy';
import { ConnectorError, type Connector } from './types';

const uuid = z.string().length(36).uuid().regex(/^[0-9a-f-]+$/);
const missing = z.object({ siteId: uuid, projectRef: z.string(), missing: z.literal(true) }).strict();
const unavailable = () => new ConnectorError('CATALOG_AUTHORIZATION_UNAVAILABLE',
  'The external analytics mapping could not be verified. Direct analytics is unavailable.', 503);

/** Server only. The caller MUST already have authorized connector use for the current actor and agent.
 * A mapping describes a workspace's analytical sources; possession of one never confers access. */
export async function loadExternalDataset(connector: Connector): Promise<AnalyticsDataset | null> {
  const { id, site_id: site, supabase_project_ref: ref, revision } = connector;
  if (!isBoundSupabaseProject(connector) || !ref || !uuid.safeParse(id).success || !uuid.safeParse(site).success ||
    connector.enabled !== true || !connector.verified_at || connector.provider_status !== 'ACTIVE' ||
    connector.revocation_pending !== false || connector.revocation_dispatched !== false ||
    !Number.isSafeInteger(revision) || revision < 1) {
    throw new ConnectorError('CONNECTOR_PROJECT_UNBOUND', 'An active verified Supabase connector and project binding are required.', 409);
  }
  let response;
  try {
    response = await supabaseAdmin.rpc('connector_external_analytics_dataset', {
      p_site_id: site, p_connector_id: id, p_project_ref: ref, p_connector_revision: revision,
    }).abortSignal(AbortSignal.timeout(5_000));
  } catch { throw unavailable(); }
  if (response?.error?.code === 'P0C02') throw new ConnectorError('ACCESS_CHANGED', 'The connector binding is no longer authorized.', 403);
  if (response?.error !== null) throw unavailable();

  // Require an affirmative, bound absence from the function, not a null/empty transport response.
  const absent = missing.safeParse(response.data);
  if (absent.success && absent.data.siteId === site && absent.data.projectRef === ref) return null;
  const dataset = externalDataset(ref, site, response.data);
  if (!dataset) throw unavailable();
  return dataset;
}
