import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { privateResultBinding } from './private-result-delivery';
import type { AnalyticsScope } from './supabase-analytics-sources';
import { SUPABASE_CATALOG_SLUG } from './supabase-report-contract';
import { ConnectorError } from './types';

type Binding = ReturnType<typeof privateResultBinding>;
export type AnalyticsAuthority = { scope: AnalyticsScope; projectRef: string; grantId: string | null; source: string };
const denied = (scope?: AnalyticsScope) => scope === 'workspace'
  ? new ConnectorError('ANALYTICS_WORKSPACE_DENIED', 'Workspace analytics requires current actor, agent and source access. Procurement also requires an eligible owner/admin.', 403)
  : new ConnectorError('ANALYTICS_SCOPE_DENIED', 'The verified actor and agent do not have current access to this analytics source and scope.', 403);
const unavailable = () => new ConnectorError('CATALOG_AUTHORIZATION_UNAVAILABLE', 'The private analytics authorization could not be verified.', 503);
const confirmation = z.object({ allowed: z.boolean(), grant_id: z.string().uuid().nullable() }).strict();
function args(binding: Binding, projectRef: string, scope: AnalyticsScope, source: string) {
  if (!binding.p_catalog || binding.p_tool !== SUPABASE_CATALOG_SLUG || !/^[a-z]{20}$/.test(projectRef) || projectRef.length !== 20 ||
    !['workspace','platform'].includes(scope) || !/^[a-z][a-z0-9_]{0,47}$/.test(source) || /[^a-z0-9_]/.test(source)) throw denied(scope);
  return { ...binding, p_project_ref: projectRef, p_source: source, p_data_scope: scope };
}
export async function authorizeAnalyticsResult(binding: Binding, projectRef: string, scope: AnalyticsScope, source: string): Promise<AnalyticsAuthority> {
  const parameters = args(binding, projectRef, scope, source);
  let result;
  try { result = await supabaseAdmin.rpc('connector_analytics_result_ready', parameters).abortSignal(AbortSignal.timeout(5000)); }
  catch { throw unavailable(); }
  const stamp = confirmation.safeParse(result.data);
  if (result.error || !stamp.success) throw unavailable();
  if (stamp.data.allowed !== true || (scope === 'workspace') !== (stamp.data.grant_id === null)) throw denied(scope);
  return { scope, projectRef, source, grantId: stamp.data.grant_id };
}
