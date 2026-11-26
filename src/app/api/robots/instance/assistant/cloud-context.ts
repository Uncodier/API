import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveRequirementEnvironment } from '@/lib/services/requirement-environment';
import { TransientBindingPreflightError } from './assistant-turn-retry';
import type { CloudScope } from '@/lib/cloud-files/types';

const PLAN_PAGE_SIZE = 1000;
const MAX_PLAN_ROWS = 10000;

/** Binding comes from persisted requirement ownership, never a title classifier. */
export async function resolveAssistantFileEnvironment(scope: CloudScope, phase?: 'initial-preflight'): Promise<{
  environment?: 'cloud' | 'workspace'; requirementId?: string;
}> {
  function unavailable(error: { code?: string }): never {
    // Pool acquisition timeout, exhausted connections, or database starting up.
    if (phase === 'initial-preflight' && ['PGRST003', '53300', '57P03'].includes(error.code ?? '')) {
      throw new TransientBindingPreflightError();
    }
    throw new Error('Requirement file environment is unavailable');
  }
  // An explicit ID is an assertion of the current binding, not an override.
  const { data, error } = await supabaseAdmin.from('requirements').select('id,metadata')
    .eq('site_id', scope.siteId).eq('metadata->>runner_instance_id', scope.instanceId).limit(2);
  if (error) unavailable(error);
  if ((data?.length ?? 0) > 1) throw new Error('Instance has conflicting requirement bindings');
  const ids = new Set<string>((data ?? []).map(row => row.id));

  // Include every legacy plan association even when runner metadata exists.
  // Limiting before deduplication can hide A,A,B conflicts. Stable pagination
  // bounds the work; reaching the cap without proving exhaustion fails closed.
  for (let offset = 0; offset < MAX_PLAN_ROWS; offset += PLAN_PAGE_SIZE) {
    const plans = await supabaseAdmin.from('instance_plans').select('metadata').eq('site_id', scope.siteId)
      .eq('instance_id', scope.instanceId).not('metadata->>requirement_id', 'is', null)
      .order('id', { ascending: true }).range(offset, offset + PLAN_PAGE_SIZE - 1);
    if (plans.error) unavailable(plans.error);
    for (const row of plans.data ?? []) {
      const id = row.metadata?.requirement_id;
      if (typeof id !== 'string' || !id.trim()) throw new Error('Requirement file environment is unavailable');
      ids.add(id);
    }
    if (ids.size > 1) throw new Error('Instance has conflicting requirement bindings');
    if ((plans.data?.length ?? 0) < PLAN_PAGE_SIZE) break;
    if (offset + PLAN_PAGE_SIZE >= MAX_PLAN_ROWS) throw new Error('Requirement file environment is unavailable');
  }

  const [requirementId] = [...ids];
  if (scope.requirementId && scope.requirementId !== requirementId) {
    throw new Error('Requirement file environment is inaccessible');
  }
  if (!requirementId) return {};
  let requirement = data?.[0];
  if (!requirement) {
    const result = await supabaseAdmin.from('requirements').select('id,metadata')
      .eq('site_id', scope.siteId).eq('id', requirementId).limit(2);
    if (result.error) unavailable(result.error);
    if (result.data?.length !== 1) throw new Error('Requirement file environment is inaccessible');
    requirement = result.data[0];
  }
  return { environment: resolveRequirementEnvironment(requirement.metadata), requirementId: requirement.id };
}