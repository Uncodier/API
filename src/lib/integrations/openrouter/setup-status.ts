import 'server-only';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { OpenRouterError } from './types';

/** Called only after manager authorization. Never return raw provider evidence. */
export async function setupStatus(siteId: string) {
  const { data, error } = await supabaseAdmin.from('openrouter_setup_runs')
    .select('operation_id,kind,state,max_cost,created_at,finished_at,evidence')
    .eq('site_id', siteId).order('created_at', { ascending:false }).limit(20);
  if (error) throw new OpenRouterError('setup_status_unavailable','Setup status could not be loaded');
  return { runs: (data ?? []).map(row => ({ operationId: row.operation_id, kind: row.kind,
    state: row.state, maxCostUsd: Number(row.max_cost), gatewayCost: typeof row.evidence?.gatewayCost === 'number' ? row.evidence.gatewayCost : null,
    createdAt: row.created_at, finishedAt: row.finished_at, platformCharge: 0 })) };
}