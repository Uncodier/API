import 'server-only';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { OpenRouterError, type ConnectionRow } from './types';

export async function claimSetup(row: ConnectionRow, actorId: string, operationId: string, kind: 'recommend' | 'verify', fingerprint: string, maxCostUsd: number) {
  const { data, error } = await supabaseAdmin.rpc('openrouter_setup_claim', {
    p_site_id: row.site_id, p_actor_id: actorId, p_operation_id: operationId,
    p_expected_revision: row.revision, p_kind: kind, p_fingerprint: fingerprint, p_max_cost: maxCostUsd,
  });
  if (error || data !== true) throw new OpenRouterError('setup_conflict', 'Setup was already attempted or the connection changed. Check its status; it will not be replayed.', 409);
}
export async function finishSetup(siteId: string, operationId: string, state: 'completed' | 'uncertain' | 'failed', evidence: Record<string, unknown>) {
  const { error } = await supabaseAdmin.rpc('openrouter_setup_finish', { p_site_id: siteId, p_operation_id: operationId, p_state: state, p_evidence: evidence });
  if (error) throw new OpenRouterError('setup_uncertain', 'Setup outcome requires reconciliation. Do not retry the provider request.', 409);
}