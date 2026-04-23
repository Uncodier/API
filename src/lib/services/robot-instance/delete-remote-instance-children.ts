/**
 * Clears the only dependent table of `remote_instances` that can grow unbounded
 * (`instance_logs`) BEFORE issuing `DELETE FROM remote_instances`.
 *
 * Real foreign keys to remote_instances (see supabase/database.md):
 *   - instance_logs.instance_id         ON DELETE CASCADE   (can be huge → clean first)
 *   - instance_plans.instance_id        ON DELETE CASCADE   (small → cascade is fine)
 *   - automation_auth_sessions.instance_id  ON DELETE SET NULL
 *
 * Everything else we used to touch here (instance_assets, instance_sessions,
 * remote_sessions, instance_nodes, instance_plan_steps, requirement_status,
 * requirements.instance_id) does not exist in the current schema and was
 * generating harmless but confusing "schema cache" errors.
 *
 * Prefer DB function `delete_instance_logs_batch` (src/scripts/delete_instance_logs_batch_fn.sql)
 * so each batch is a single bounded DELETE. Requires the indexes from
 * src/scripts/add_instance_logs_perf_indexes.sql — without the
 * (parent_log_id) index the ON DELETE SET NULL self-FK forces a seq scan
 * per deleted row and the function times out.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';

const LOG_REST_SELECT_BATCH = 200;
const LOG_REST_ID_CHUNK = 50;
const MAX_DELETE_ROUNDS = 2000;
const PROGRESS_LOG_EVERY_ROUNDS = 1;

const LOG_RPC_BATCH = 500;
const LOG_RPC_MIN_BATCH = 25;
const MAX_LOG_RPC_CALLS = 500_000;

const DELETE_MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 75;

/** Serialize cleanups per instance so overlapping requests don't deadlock each other. */
const deleteChildrenInFlight = new Map<string, Promise<{ ok: boolean; error?: string }>>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isDeadlockMessage(message: string | undefined): boolean {
  return (message ?? '').toLowerCase().includes('deadlock');
}

function isTimeoutMessage(message: string | undefined): boolean {
  return (message ?? '').toLowerCase().includes('statement timeout');
}

function isRpcNotFoundError(error: { message?: string; code?: string }): boolean {
  const m = (error.message || '').toLowerCase();
  return (
    error.code === 'PGRST202' ||
    m.includes('could not find the function') ||
    m.includes('does not exist')
  );
}

function parseRpcDeletedCount(data: unknown): number {
  if (typeof data === 'number' && !Number.isNaN(data)) return data;
  if (typeof data === 'string') {
    const n = Number(data);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function withRetries<T extends { error: { message: string; code?: string } | null }>(
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= DELETE_MAX_ATTEMPTS; attempt++) {
    const result = await run();
    if (!result.error) return result;
    const msg = result.error.message;
    const retryable = isDeadlockMessage(msg) || isTimeoutMessage(msg);
    if (retryable && attempt < DELETE_MAX_ATTEMPTS) {
      const wait = BASE_BACKOFF_MS * attempt + Math.floor(Math.random() * 100);
      console.warn(
        `[deleteRemoteInstanceChildren] ${label} retry ${attempt}/${DELETE_MAX_ATTEMPTS} after: ${msg} (wait ${wait}ms)`,
      );
      await sleep(wait);
      continue;
    }
    return result;
  }
  throw new Error(`[deleteRemoteInstanceChildren] ${label}: exhausted retries`);
}

async function callDeleteLogsRpc(
  instanceId: string,
  limit: number,
): Promise<{ data: unknown; error: { message: string; code?: string } | null }> {
  return supabaseAdmin.rpc('delete_instance_logs_batch', {
    p_instance_id: instanceId,
    p_limit: limit,
  });
}

/**
 * Fast path: one DELETE per RPC call. Returns usedRpc=false if the function is
 * missing so caller can fall back to REST batches.
 */
async function deleteInstanceLogsViaRpc(instanceId: string): Promise<{
  error: Error | null;
  usedRpc: boolean;
}> {
  let total = 0;
  let calls = 0;
  let limit = LOG_RPC_BATCH;

  while (calls < MAX_LOG_RPC_CALLS) {
    let attempt = 0;
    let data: unknown = null;
    let lastError: { message: string; code?: string } | null = null;

    while (attempt < DELETE_MAX_ATTEMPTS) {
      const result = await callDeleteLogsRpc(instanceId, limit);
      if (!result.error) {
        data = result.data;
        lastError = null;
        break;
      }
      if (calls === 0 && attempt === 0 && isRpcNotFoundError(result.error)) {
        return { error: null, usedRpc: false };
      }
      lastError = result.error;
      const msg = result.error.message;
      const retryable = isDeadlockMessage(msg) || isTimeoutMessage(msg);
      if (!retryable) break;

      if (isTimeoutMessage(msg) && limit > LOG_RPC_MIN_BATCH) {
        const next = Math.max(LOG_RPC_MIN_BATCH, Math.floor(limit / 2));
        console.warn(
          `[deleteRemoteInstanceChildren] delete_instance_logs_batch timeout — shrinking batch ${limit} → ${next}`,
        );
        limit = next;
      } else {
        const wait = BASE_BACKOFF_MS * (attempt + 1) + Math.floor(Math.random() * 100);
        console.warn(
          `[deleteRemoteInstanceChildren] delete_instance_logs_batch retry ${attempt + 1}/${DELETE_MAX_ATTEMPTS} after: ${msg} (wait ${wait}ms)`,
        );
        await sleep(wait);
      }
      attempt++;
    }

    if (lastError) {
      return {
        error: new Error(`delete_instance_logs_batch: ${lastError.message}`),
        usedRpc: true,
      };
    }

    calls++;
    const n = parseRpcDeletedCount(data);
    if (n === 0) break;
    total += n;
    if (calls === 1 || calls % 5 === 0 || n < limit) {
      console.log(
        `[deleteRemoteInstanceChildren] instance_logs (rpc): removed ${total} row(s) (rpc call ${calls}, batch ${limit})`,
      );
    }
  }

  if (calls > 0) {
    console.log(`[deleteRemoteInstanceChildren] instance_logs (rpc) done, total ${total} row(s)`);
  }
  return { error: null, usedRpc: calls > 0 };
}

/** REST fallback (also used when the RPC is not installed yet) */
async function deleteInstanceLogsViaRest(instanceId: string): Promise<{ error: Error | null }> {
  let totalDeleted = 0;

  for (let round = 0; round < MAX_DELETE_ROUNDS; round++) {
    const selResult = await withRetries('instance_logs select', () =>
      supabaseAdmin
        .from('instance_logs')
        .select('id')
        .eq('instance_id', instanceId)
        .limit(LOG_REST_SELECT_BATCH),
    );

    if (selResult.error) {
      return { error: new Error(`instance_logs select: ${selResult.error.message}`) };
    }
    const data = selResult.data;
    if (!data?.length) break;

    const ids = data.map((r: { id: string }) => r.id).sort();
    totalDeleted += ids.length;

    if (round === 0 || (round + 1) % PROGRESS_LOG_EVERY_ROUNDS === 0 || ids.length < LOG_REST_SELECT_BATCH) {
      console.log(
        `[deleteRemoteInstanceChildren] instance_logs (rest): deleted ${totalDeleted} row(s) so far (round ${round + 1})`,
      );
    }

    for (const part of chunk(ids, LOG_REST_ID_CHUNK)) {
      const delResult = await withRetries('instance_logs delete chunk', () =>
        supabaseAdmin.from('instance_logs').delete().in('id', part),
      );
      if (delResult.error) {
        return { error: new Error(`instance_logs: ${delResult.error.message}`) };
      }
    }
  }

  return { error: null };
}

async function deleteRemoteInstanceChildrenImpl(instanceId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  console.log('[deleteRemoteInstanceChildren] start', { instanceId });

  const rpc = await deleteInstanceLogsViaRpc(instanceId);
  if (rpc.error) return { ok: false, error: rpc.error.message };

  if (!rpc.usedRpc) {
    console.warn(
      '[deleteRemoteInstanceChildren] RPC delete_instance_logs_batch not installed — falling back to REST batches (install src/scripts/delete_instance_logs_batch_fn.sql for best performance).',
    );
    const restResult = await deleteInstanceLogsViaRest(instanceId);
    if (restResult.error) return { ok: false, error: restResult.error.message };
  }

  console.log('[deleteRemoteInstanceChildren] instance_logs done');
  console.log('[deleteRemoteInstanceChildren] complete', { instanceId });
  return { ok: true };
}

/**
 * Removes the bulky `instance_logs` for this instance so the subsequent
 * `DELETE FROM remote_instances WHERE id = ?` stays under statement_timeout.
 * The rest (`instance_plans`, `automation_auth_sessions`) is handled by the
 * parent's CASCADE / SET NULL constraints.
 */
export async function deleteRemoteInstanceChildren(instanceId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const existing = deleteChildrenInFlight.get(instanceId);
  if (existing) {
    console.log('[deleteRemoteInstanceChildren] joining in-flight cleanup for instance', instanceId);
    return existing;
  }

  const promise = deleteRemoteInstanceChildrenImpl(instanceId).finally(() => {
    deleteChildrenInFlight.delete(instanceId);
  });
  deleteChildrenInFlight.set(instanceId, promise);
  return promise;
}
