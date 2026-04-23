/**
 * Per-requirement advisory lock for cron workflows.
 *
 * Problem: cron routes fire every 5 (apps) / 1 (automations) minutes, but a
 * single workflow often exceeds that interval. Without this lock two runs
 * target the same feature branch, race on `git push`, and one side is
 * rejected as non-fast-forward (or they clobber each other's sandbox files).
 *
 * Design:
 *  - `acquireRunLock` performs one atomic UPDATE:
 *      SET cron_lock_expires_at = :expiresAt, cron_lock_run_id = :runId
 *      WHERE id = :reqId
 *        AND (cron_lock_expires_at IS NULL OR cron_lock_expires_at < NOW())
 *    If no row is affected, another workflow already holds the lock.
 *  - `releaseRunLock` clears the columns only when the caller still owns the
 *    lock (matches `runId`), so a stale release from a crashed run cannot
 *    unlock a newer owner.
 *  - TTL is the safety net: if a workflow crashes before release, the next
 *    tick after expiry can still pick the requirement up.
 *
 * Usage:
 *  - Cron routes (regular Next.js runtime) import these helpers directly.
 *  - Workflow modules (`'use workflow'`) must NOT call these directly — Supabase
 *    uses `fetch` which is not available in the workflow VM. Instead, call
 *    `releaseRunLockStep` from `./cron-steps.ts`, which wraps the release in
 *    a durable step.
 *
 * Columns and indexes come from
 * `src/scripts/add_requirements_cron_run_lock.sql`; run that migration before
 * relying on these helpers (they degrade gracefully when the columns are
 * missing, logging a warning and allowing the workflow to proceed).
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * UUID generator that works inside the Vercel Workflow bundle (no `require`
 * available) AND in regular Node. Uses Web Crypto via `globalThis.crypto`
 * when present; falls back to a non-cryptographic id good enough to identify
 * lock ownership.
 */
function makeRunId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    return `cron-${g.crypto.randomUUID()}`;
  }
  return `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Default TTL for a cron workflow lock (15 minutes — longer than any expected run). */
export const CRON_RUN_LOCK_TTL_MS = 15 * 60 * 1000;

export interface AcquiredCronLock {
  runId: string;
  expiresAt: string;
}

/**
 * PostgREST error shape exposed by @supabase/supabase-js. Carries `code`
 * (PostgreSQL SQLSTATE or PGRST* code), `details` and `hint` — all of
 * which we want in logs to distinguish a schema-cache miss from RLS,
 * permission, or filter-syntax errors.
 */
interface PostgrestErrorLike {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * `true` only when the error unambiguously indicates the lock columns are
 * unknown to PostgREST. We check the SQLSTATE (`42703` = undefined_column)
 * and the PGRST-specific schema-cache code in addition to the message, so
 * we don't silently swallow unrelated failures (RLS, permission, filter
 * syntax, etc.) under the "columns missing" branch.
 */
function isLockColumnsMissingError(err: PostgrestErrorLike): boolean {
  const code = err.code || '';
  if (code === '42703' || code === 'PGRST204') return true;
  const msg = err.message || '';
  return (
    /column\s+[^\s]*cron_lock_(expires_at|run_id)\s+does not exist/i.test(msg) ||
    /could not find the '?cron_lock_(expires_at|run_id)'? column/i.test(msg)
  );
}

/** Returns true-ish AcquiredCronLock if we took the lock; null if another run owns it. */
export async function acquireRunLock(
  requirementId: string,
  opts?: { ttlMs?: number; runId?: string },
): Promise<AcquiredCronLock | null> {
  const ttlMs = opts?.ttlMs ?? CRON_RUN_LOCK_TTL_MS;
  const runId = opts?.runId ?? makeRunId();
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const { data, error } = await supabaseAdmin
    .from('requirements')
    .update({ cron_lock_expires_at: expiresAt, cron_lock_run_id: runId })
    .eq('id', requirementId)
    .or(`cron_lock_expires_at.is.null,cron_lock_expires_at.lt.${nowIso}`)
    .select('id');

  if (error) {
    const err = error as PostgrestErrorLike;
    // Log the *full* PostgREST error (code/details/hint) so a schema-cache
    // miss can be distinguished from RLS, permission, or filter errors.
    const diag = {
      reqId: requirementId,
      code: err.code,
      message: err.message,
      details: err.details,
      hint: err.hint,
    };
    if (isLockColumnsMissingError(err)) {
      console.warn(
        '[CronRunLock] columns missing — running without lock. ' +
          'Apply src/scripts/add_requirements_cron_run_lock.sql AND reload the ' +
          "PostgREST schema cache (Supabase Dashboard → API → 'Reload schema cache', " +
          "or run `NOTIFY pgrst, 'reload schema';`).",
        diag,
      );
      return { runId, expiresAt };
    }
    console.warn('[CronRunLock] acquire failed', diag);
    return null;
  }

  if (!data || data.length === 0) {
    return null;
  }

  return { runId, expiresAt };
}

/**
 * Releases the lock only when the caller still owns it (matches runId).
 * Safe to call multiple times; never throws.
 */
export async function releaseRunLock(requirementId: string, runId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from('requirements')
      .update({ cron_lock_expires_at: null, cron_lock_run_id: null })
      .eq('id', requirementId)
      .eq('cron_lock_run_id', runId);

    if (error) {
      const err = error as PostgrestErrorLike;
      if (isLockColumnsMissingError(err)) {
        return;
      }
      console.warn('[CronRunLock] release failed', {
        reqId: requirementId,
        code: err.code,
        message: err.message,
        details: err.details,
        hint: err.hint,
      });
    }
  } catch (e: unknown) {
    console.warn(`[CronRunLock] release threw for ${requirementId}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Extends the lock expiry for a long-running workflow. Only affects the row
 * when the caller still owns the lock. Use in the middle of a workflow if
 * the run is approaching the TTL.
 */
export async function extendRunLock(
  requirementId: string,
  runId: string,
  ttlMs: number = CRON_RUN_LOCK_TTL_MS,
): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await supabaseAdmin
      .from('requirements')
      .update({ cron_lock_expires_at: expiresAt })
      .eq('id', requirementId)
      .eq('cron_lock_run_id', runId);
  } catch (e: unknown) {
    console.warn(`[CronRunLock] extend threw for ${requirementId}:`, e instanceof Error ? e.message : e);
  }
}
