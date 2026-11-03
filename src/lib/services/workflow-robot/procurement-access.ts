import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getRequestSitePrincipal } from '@/lib/security/site-access';

export const PROCUREMENT_WORKFLOW_TABLES = [
  'suppliers', 'supplier_contacts', 'catalog_item_suppliers',
  'procurement_requests', 'procurement_tenders', 'procurement_tender_publications',
  'procurement_tender_participants', 'procurement_event_approvals',
  'procurement_awards', 'purchase_orders', 'procurement_receipts',
  'procurement_replenishment_rules', 'procurement_replenishment_cases',
] as const;

export function isProcurementWorkflowTable(table: unknown): boolean {
  return typeof table === 'string' && PROCUREMENT_WORKFLOW_TABLES.some(value => value === table);
}

/** Never authorize from the subscription author or a model-supplied actor. */
export async function assertProcurementWorkflowActorAccess(siteId: string, userId: string | null | undefined): Promise<void> {
  if (!userId) throw new Error('Procurement workflow actor is required');
  const { data, error } = await supabaseAdmin.rpc('procurement_workflow_actor_can_read', {
    p_site: siteId, p_actor: userId,
  });
  if (error || data !== true) throw new Error('Procurement workflow access denied');
}

/** Fail closed if the security migration or canonical permission lookup is unavailable. */
export async function canReadProcurementWorkflowInstanceAsActor(
  siteId: string, instanceId: string, userId: string | null,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc('procurement_workflow_instance_can_read', {
    p_site: siteId, p_instance: instanceId, p_actor: userId,
  });
  return !error && data === true;
}

export async function authorizeProcurementWorkflowInstanceRead(
  request: Request, instanceId: string, siteId: string,
): Promise<boolean> {
  const { internal, userId } = getRequestSitePrincipal(request);
  if (internal) return true;
  return canReadProcurementWorkflowInstanceAsActor(siteId, instanceId, userId);
}

export async function filterAccessibleProcurementWorkflowInstances(
  siteId: string, userId: string | null, instanceIds: string[],
): Promise<Set<string>> {
  const unique = Array.from(new Set(instanceIds));
  const results = await Promise.all(unique.map(async id => ({
    id, allowed: await canReadProcurementWorkflowInstanceAsActor(siteId, id, userId),
  })));
  return new Set(results.filter(result => result.allowed).map(result => result.id));
}