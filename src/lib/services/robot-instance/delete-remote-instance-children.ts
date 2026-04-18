/**
 * Deletes or unlinks rows that reference a remote instance before deleting `remote_instances`.
 * Avoids statement timeouts from implicit CASCADE deletes (especially `instance_logs`).
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';

const ID_IN_CHUNK = 120;
const LOG_SELECT_BATCH = 800;
const ASSET_SELECT_BATCH = 800;
/** Safety cap to avoid infinite loops if deletes silently no-op */
const MAX_DELETE_ROUNDS = 2000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function deleteByIdsInChunks(
  table: string,
  ids: string[],
): Promise<{ error: Error | null }> {
  if (ids.length === 0) return { error: null };
  for (const part of chunk(ids, ID_IN_CHUNK)) {
    const { error } = await supabaseAdmin.from(table).delete().in('id', part);
    if (error) return { error: new Error(`${table}: ${error.message}`) };
  }
  return { error: null };
}

async function deleteRowsBatched(
  table: string,
  filterColumn: string,
  filterValue: string,
  selectBatch: number,
): Promise<{ error: Error | null }> {
  for (let round = 0; round < MAX_DELETE_ROUNDS; round++) {
    const { data, error: selErr } = await supabaseAdmin
      .from(table)
      .select('id')
      .eq(filterColumn, filterValue)
      .limit(selectBatch);

    if (selErr) return { error: new Error(`${table} select: ${selErr.message}`) };
    if (!data?.length) break;

    const { error: delErr } = await deleteByIdsInChunks(
      table,
      data.map((r: { id: string }) => r.id),
    );
    if (delErr) return { error: delErr };
  }
  return { error: null };
}

async function clearInstanceNodeGraph(instanceId: string): Promise<{ error: Error | null }> {
  const { data: nodes, error: nErr } = await supabaseAdmin
    .from('instance_nodes')
    .select('id')
    .eq('instance_id', instanceId);

  if (nErr) return { error: new Error(`instance_nodes select: ${nErr.message}`) };
  const nodeIds = (nodes ?? []).map((n: { id: string }) => n.id);
  if (nodeIds.length === 0) return { error: null };

  for (const part of chunk(nodeIds, ID_IN_CHUNK)) {
    const { error: tErr } = await supabaseAdmin
      .from('instance_node_contexts')
      .delete()
      .in('target_node_id', part);
    if (tErr) return { error: new Error(`instance_node_contexts: ${tErr.message}`) };
  }
  for (const part of chunk(nodeIds, ID_IN_CHUNK)) {
    const { error: cErr } = await supabaseAdmin
      .from('instance_node_contexts')
      .delete()
      .in('context_node_id', part);
    if (cErr) return { error: new Error(`instance_node_contexts: ${cErr.message}`) };
  }

  const { error: delNodes } = await supabaseAdmin
    .from('instance_nodes')
    .delete()
    .eq('instance_id', instanceId);
  if (delNodes) return { error: new Error(`instance_nodes: ${delNodes.message}`) };

  return { error: null };
}

async function deletePlanStepsForInstance(instanceId: string): Promise<void> {
  const { data: plans, error } = await supabaseAdmin
    .from('instance_plans')
    .select('id')
    .eq('instance_id', instanceId);

  if (error || !plans?.length) return;

  const planIds = plans.map((p: { id: string }) => p.id);

  async function deleteSteps(column: 'instance_plan_id' | 'plan_id'): Promise<boolean> {
    for (const part of chunk(planIds, ID_IN_CHUNK)) {
      const { error: sErr } = await supabaseAdmin
        .from('instance_plan_steps')
        .delete()
        .in(column, part);
      if (sErr) {
        console.warn(
          `[deleteRemoteInstanceChildren] instance_plan_steps (${column}):`,
          sErr.message,
        );
        return false;
      }
    }
    return true;
  }

  if (await deleteSteps('instance_plan_id')) return;
  await deleteSteps('plan_id');
}

/**
 * Removes dependent DB rows so `DELETE FROM remote_instances WHERE id = ?` stays fast.
 */
export async function deleteRemoteInstanceChildren(instanceId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const { error: logsErr } = await deleteRowsBatched(
    'instance_logs',
    'instance_id',
    instanceId,
    LOG_SELECT_BATCH,
  );
  if (logsErr) return { ok: false, error: logsErr.message };

  const { error: graphErr } = await clearInstanceNodeGraph(instanceId);
  if (graphErr) return { ok: false, error: graphErr.message };

  const { error: assetsErr } = await deleteRowsBatched(
    'instance_assets',
    'instance_id',
    instanceId,
    ASSET_SELECT_BATCH,
  );
  if (assetsErr) {
    console.warn('[deleteRemoteInstanceChildren] instance_assets:', assetsErr.message);
  }

  const { error: filesErr } = await deleteRowsBatched(
    'assets',
    'instance_id',
    instanceId,
    ASSET_SELECT_BATCH,
  );
  if (filesErr) {
    console.warn('[deleteRemoteInstanceChildren] assets:', filesErr.message);
  }

  const { error: sessErr } = await supabaseAdmin
    .from('instance_sessions')
    .delete()
    .eq('instance_id', instanceId);
  if (sessErr) {
    console.warn('[deleteRemoteInstanceChildren] instance_sessions:', sessErr.message);
  }

  const { error: rsUp } = await supabaseAdmin
    .from('remote_sessions')
    .update({ instance_id: null })
    .eq('instance_id', instanceId);
  if (rsUp) {
    const { error: rsDel } = await supabaseAdmin
      .from('remote_sessions')
      .delete()
      .eq('instance_id', instanceId);
    if (rsDel) {
      console.warn('[deleteRemoteInstanceChildren] remote_sessions:', rsDel.message);
    }
  }

  const { error: reqErr } = await supabaseAdmin
    .from('requirements')
    .update({ instance_id: null })
    .eq('instance_id', instanceId);
  if (reqErr) {
    console.warn('[deleteRemoteInstanceChildren] requirements:', reqErr.message);
  }

  const { error: stErr } = await supabaseAdmin
    .from('requirement_status')
    .update({ instance_id: null })
    .eq('instance_id', instanceId);
  if (stErr) {
    console.warn('[deleteRemoteInstanceChildren] requirement_status:', stErr.message);
  }

  await deletePlanStepsForInstance(instanceId);

  const { error: plansErr } = await supabaseAdmin
    .from('instance_plans')
    .delete()
    .eq('instance_id', instanceId);
  if (plansErr) {
    return { ok: false, error: `instance_plans: ${plansErr.message}` };
  }

  return { ok: true };
}
