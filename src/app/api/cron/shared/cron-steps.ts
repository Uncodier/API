/**
 * Durable step functions for cron workflows.
 *
 * This is a 'use step' file — each function runs in the Next.js runtime,
 * NOT in the workflow VM. This means we can safely import @vercel/sandbox,
 * next/server, and any other Node.js module.
 *
 * Pattern: steps receive `sandboxId` (string) and reconnect via Sandbox.get().
 * The workflow only passes serializable data between steps.
 */
'use step';

import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  connectOrRecreateRequirementSandbox,
  getSandboxWithRetriesOrThrow,
} from '@/lib/services/sandbox-recovery';
import { getActiveInstancePlan as _getActiveInstancePlan } from '@/app/api/robots/instance/assistant/plan-steps';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { commitWorkspaceToOrigin, type GitRepoKind } from './cron-commit-helpers';
import {
  releaseRunLock as _releaseRunLockImpl,
  extendRunLock as _extendRunLockImpl,
  CRON_RUN_LOCK_TTL_MS,
} from './cron-run-lock';
import { uploadSandboxSourceArchiveToRepository } from '@/app/api/agents/tools/sandbox/sandbox-source-upload';
import { validateBuildForStep } from './step-git-gate';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';

// Re-exports live in sibling modules — this file is 'use step' and may only export async step fns here.

// ─── Serializable return types ───────────────────────────────────────

export interface SandboxInfo {
  sandboxId: string;
  branchName: string;
  workDir: string;
  isNewBranch: boolean;
  instanceType: string;
}

// ─── Step: Create sandbox ────────────────────────────────────────────

export async function createSandboxStep(
  reqId: string,
  instanceType: string,
  title: string,
  audit?: CronAuditContext,
): Promise<SandboxInfo> {
  'use step';
  const result = await SandboxService.createRequirementSandbox(reqId, instanceType, title, audit);

  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.WORKFLOW_SANDBOX_READY,
    message: `Sandbox ready for cron (VM + git + npm): ${result.sandbox.sandboxId} @ ${result.branchName}`,
    details: {
      sandboxId: result.sandbox.sandboxId,
      branchName: result.branchName,
      workDir: result.workDir,
      isNewBranch: result.isNewBranch,
      instanceType: result.instanceType,
      requirementId: reqId,
    },
  });

  return {
    sandboxId: result.sandbox.sandboxId,
    branchName: result.branchName,
    workDir: result.workDir,
    isNewBranch: result.isNewBranch,
    instanceType: result.instanceType,
  };
}

// ─── Step: Clean up nested project directories ──────────────────────

/**
 * Removes mistaken nested Next roots. After a fresh `createSandboxStep`, pass
 * **no** `recovery` — only `Sandbox.get` with retries. Passing `recovery` runs
 * `connectOrRecreateRequirementSandbox`, which provisions a **new** VM when
 * `get` fails transiently right after create → duplicate snapshot sandboxes
 * billing in parallel.
 */
export async function cleanupNestedProjectsStep(
  sandboxId: string,
  audit?: CronAuditContext,
  recovery?: { requirementId: string; title: string; instanceType: string },
): Promise<{ removed: string[]; effectiveSandboxId: string }> {
  'use step';
  let effectiveSandboxId = sandboxId;
  let sandbox: Sandbox;
  if (recovery) {
    const conn = await connectOrRecreateRequirementSandbox({
      sandboxId,
      requirementId: recovery.requirementId,
      instanceType: recovery.instanceType,
      title: recovery.title,
      audit,
    });
    sandbox = conn.sandbox;
    effectiveSandboxId = conn.sandboxId;
  } else {
    sandbox = await getSandboxWithRetriesOrThrow(sandboxId);
  }
  const cwd = SandboxService.WORK_DIR;
  const removed: string[] = [];

  // Detect nested project directories by looking for package.json in
  // immediate subdirectories. A subdir with its own package.json + next.config
  // is almost certainly a misplaced nested project from a previous agent run.
  const candidates = ['app', 'my-app', 'frontend', 'project', 'web'];

  for (const dir of candidates) {
    const checkRes = await sandbox.runCommand('sh', [
      '-c',
      `test -f ${cwd}/${dir}/package.json && test -f ${cwd}/${dir}/next.config.ts -o -f ${cwd}/${dir}/next.config.mjs -o -f ${cwd}/${dir}/next.config.js && echo "NESTED"`,
    ]);
    const stdout = await checkRes.stdout();
    if (stdout.trim() === 'NESTED') {
      console.log(`[Cleanup] Removing nested project directory: ${dir}/`);
      await sandbox.runCommand('rm', ['-rf', `${cwd}/${dir}`]);
      removed.push(dir);
    }
  }

  // Models often scaffold `app/src/app/...` at repo root (misreading "app directory").
  // That path is INVALID here — App Router lives only under `src/app/`. The previous
  // loop misses this when `app/` has no package.json (only files under app/src/).
  const fixWrongAppDir = await sandbox.runCommand('sh', [
    '-c',
    `cd "${cwd}" || exit 0
if [ -d src/app ] && [ -d app/src/app ]; then
  rm -rf app
  echo FIX_DUP_APP_DIR
fi
if [ -f package.json ] && [ ! -f app/package.json ] && [ -d app/src ] && [ ! -d app/src/app ]; then
  mkdir -p src
  cp -a app/src/. src/
  rm -rf app
  echo FIX_FLATTEN_APP_SRC
fi
if [ -f package.json ] && [ ! -f app/package.json ] && [ -d app/src/app ] && [ ! -d src/app ]; then
  mkdir -p src
  mv app/src/app src/app
  rm -rf app
  echo FIX_MOVE_APP_SRC_APP
fi`,
  ]);
  const fixOut = (await fixWrongAppDir.stdout()).trim();
  if (fixOut.includes('FIX_DUP_APP_DIR')) {
    removed.push('app(dup-nested-vs-src)');
    console.log('[Cleanup] Removed mistaken root app/ (canonical src/app/ already existed)');
  }
  if (fixOut.includes('FIX_FLATTEN_APP_SRC')) {
    removed.push('app(flatten-src)');
    console.log('[Cleanup] Flattened app/src/* into src/');
  }
  if (fixOut.includes('FIX_MOVE_APP_SRC_APP')) {
    removed.push('app(moved-src-app)');
    console.log('[Cleanup] Moved app/src/app → src/app and removed root app/');
  }

  if (removed.length > 0) {
    console.log(`[Cleanup] Removed ${removed.length} nested project(s): ${removed.join(', ')}`);
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.NESTED_DIRS_CLEANUP,
      message: `Removed nested/misplaced dirs: ${removed.join(', ')}`,
      details: { sandboxId: effectiveSandboxId, removed },
    });
  }

  return { removed, effectiveSandboxId };
}

// NOTE: `bootstrapRequirementSpecStep` lives in `./bootstrap-spec-step.ts`.
// It is NOT re-exported from this module because the SWC `swc-workflow-plugin`
// enforces that `'use step'` files only emit top-level async function
// declarations — any `export { … } from` form fails the build with
//   "Only async functions can be exported from a \"use step\" file".
// Callers must import the step directly from `./bootstrap-spec-step`.

// ─── Step: Get active instance plan ──────────────────────────────────

export async function getActiveInstancePlanStep(instanceId: string, siteId: string) {
  'use step';
  return _getActiveInstancePlan(instanceId, siteId);
}

// ─── Step: Recent plans guard (stops orchestrator re-plan loop) ──────

export interface RecentPlansGuardResult {
  recentCount: number;
  latestCompletedAtMs: number | null;
  shouldSkipOrchestrator: boolean;
  shouldBlockRequirement: boolean;
  reason?: string;
}

/**
 * Inspect recently completed/failed plans for an instance and decide whether
 * the orchestrator should re-plan this cycle.
 *
 * The orchestrator was looping forever because every cycle: (a) no active
 * plan existed (previous one was already `completed`), (b) the orchestrator
 * ran again and produced a fresh duplicate plan. When Gemini also returned
 * 400s mid-plan-creation, the loop kept spawning plans while the requirement
 * stayed `in-progress`. This guard short-circuits that.
 *
 * Heuristic:
 *   - If ≥ `blockAfter` completed/failed plans were created in the last
 *     `windowMinutes` minutes for the same instance, flag the requirement as
 *     BLOCKED so operators can intervene.
 *   - Otherwise, if at least one plan was completed/failed in the last
 *     `skipAfterMinutes` minutes, skip the orchestrator for this cycle and
 *     let the finalize flow run against whatever was produced.
 */
export async function checkRecentPlansGuardStep(params: {
  instanceId: string;
  siteId: string;
  windowMinutes?: number;
  skipAfterMinutes?: number;
  blockAfter?: number;
}): Promise<RecentPlansGuardResult> {
  'use step';
  const {
    instanceId,
    siteId,
    windowMinutes = 120,
    skipAfterMinutes = 20,
    blockAfter = 3,
  } = params;
  const windowStart = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('instance_plans')
    .select('id, status, created_at, completed_at')
    .eq('instance_id', instanceId)
    .eq('site_id', siteId)
    .in('status', ['completed', 'failed'])
    .gte('created_at', windowStart)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.warn('[CronStep] checkRecentPlansGuardStep query failed:', error.message);
    return {
      recentCount: 0,
      latestCompletedAtMs: null,
      shouldSkipOrchestrator: false,
      shouldBlockRequirement: false,
    };
  }

  const rows = (data ?? []) as Array<{ status: string; created_at: string; completed_at: string | null }>;
  const recentCount = rows.length;
  const latest = rows[0];
  const latestCompletedAtMs = latest?.completed_at
    ? Date.parse(latest.completed_at)
    : latest?.created_at
    ? Date.parse(latest.created_at)
    : null;

  const minutesSinceLatest =
    latestCompletedAtMs !== null ? (Date.now() - latestCompletedAtMs) / 60_000 : Infinity;

  const shouldBlockRequirement = recentCount >= blockAfter;
  const shouldSkipOrchestrator =
    shouldBlockRequirement || (recentCount >= 1 && minutesSinceLatest < skipAfterMinutes);

  let reason: string | undefined;
  if (shouldBlockRequirement) {
    reason = `${recentCount} plan(s) already completed/failed in the last ${windowMinutes} min for this instance — looks like a re-plan loop.`;
  } else if (shouldSkipOrchestrator) {
    reason = `Last plan finished ${minutesSinceLatest.toFixed(1)} min ago (<${skipAfterMinutes} min). Skip orchestrator and let the cycle finalize instead of duplicating plans.`;
  }

  return {
    recentCount,
    latestCompletedAtMs,
    shouldSkipOrchestrator,
    shouldBlockRequirement,
    reason,
  };
}

// ─── Step: Reconcile plan status ─────────────────────────────────────

export async function reconcilePlanStep(planId: string): Promise<string> {
  'use step';
  const { data: freshPlan, error: planErr } = await supabaseAdmin
    .from('instance_plans')
    .select('instance_id, site_id, steps, status')
    .eq('id', planId)
    .maybeSingle();
  if (planErr || !freshPlan?.steps) return 'unknown';

  if (freshPlan.status === 'paused' || freshPlan.status === 'cancelled') {
    console.log(`[CronStep] Plan reconcile skipped — preserved status=${freshPlan.status}`);
    return freshPlan.status;
  }

  const steps = freshPlan.steps as any[];
  const completedCount = steps.filter((s) => s.status === 'completed').length;
  const allDone = steps.every((s) => s.status === 'completed');
  const anyFailed = steps.some((s) => s.status === 'failed');
  const noPending = !steps.some((s) => s.status === 'pending' || s.status === 'in_progress');

  let planStatus = 'in_progress';
  if (allDone) planStatus = 'completed';
  else if (anyFailed && noPending) planStatus = 'failed';

  await supabaseAdmin.from('instance_plans').update({
    status: planStatus,
    steps_completed: completedCount,
    progress_percentage: Math.round((completedCount / steps.length) * 100),
    ...(planStatus === 'completed' || planStatus === 'failed' ? { completed_at: new Date().toISOString() } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', planId);
  console.log(`[CronStep] Plan → ${planStatus} (${completedCount}/${steps.length})`);

  const planAudit: CronAuditContext | undefined =
    freshPlan.instance_id && freshPlan.site_id
      ? { instanceId: freshPlan.instance_id, siteId: freshPlan.site_id }
      : undefined;
  await logCronInfrastructureEvent(planAudit, {
    event: CronInfraEvent.PLAN_RECONCILE,
    message: `Plan ${planId} reconciled → ${planStatus} (${completedCount}/${steps.length} steps completed)`,
    details: {
      plan_id: planId,
      plan_status: planStatus,
      steps_total: steps.length,
      steps_completed: completedCount,
      any_failed: anyFailed,
    },
  });

  return planStatus;
}

// ─── Step: Commit and push ───────────────────────────────────────────

export async function commitAndPushStep(
  sandboxId: string,
  title: string,
  reqId: string,
  message?: string,
  audit?: CronAuditContext,
  gitRepoKind?: GitRepoKind,
): Promise<{
  branch: string;
  pushed: boolean;
  commitCount: number;
  effectiveSandboxId: string;
} | null> {
  'use step';
  const instanceType = gitRepoKind === 'automation' ? 'automation' : 'applications';
  try {
    const connected = await connectOrRecreateRequirementSandbox({
      sandboxId,
      requirementId: reqId,
      instanceType,
      title: title?.trim() || reqId,
      audit,
    });
    let effectiveSandboxId = connected.sandboxId;
    const r = await commitWorkspaceToOrigin(connected.sandbox, title, reqId, message, audit, { gitRepoKind });
    const sand = r.sandboxReplacement ?? connected.sandbox;
    if (r.sandboxReplacement) {
      effectiveSandboxId = r.sandboxReplacement.sandboxId;
    }
    const up = await uploadSandboxSourceArchiveToRepository(sand, reqId);
    if (up.ok) {
      console.log(`[CronPersist] source archive uploaded: ${up.file} (${up.size_bytes} bytes)`);
    } else {
      console.warn('[CronPersist] source archive upload skipped/failed:', up.error);
    }
    console.log(
      `[CronPersist] commitAndPushStep finally branch=${r.branch} pushed=${r.pushed} commitCount=${r.commitCount}`,
    );
    return { ...r, effectiveSandboxId };
  } catch (err: any) {
    console.error('[CronPersist] commitAndPushStep FAILED:', err?.message || err, err?.stack);
    return null;
  }
}

/** Runs npm run build after workflow finally push — catches drift from PreCommit/layout fixes. */
export async function postFinallyBuildStep(
  sandboxId: string,
  audit?: CronAuditContext,
  recovery?: { requirementId: string; title: string; instanceType: string },
): Promise<{ ok: boolean; error?: string; effectiveSandboxId: string }> {
  'use step';
  let effectiveSandboxId = sandboxId;
  let sandbox: Sandbox;
  if (recovery) {
    const conn = await connectOrRecreateRequirementSandbox({
      sandboxId,
      requirementId: recovery.requirementId,
      instanceType: recovery.instanceType,
      title: recovery.title,
      audit,
    });
    sandbox = conn.sandbox;
    effectiveSandboxId = conn.sandboxId;
  } else {
    sandbox = await Sandbox.get({ sandboxId });
  }
  const err = await validateBuildForStep(sandbox);
  if (err) {
    console.error(`[CronPersist] post_finally_build FAILED: ${err.slice(0, 500)}`);
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.POST_FINALLY_BUILD,
      level: 'error',
      message: `post-finally npm run build failed: ${err.slice(0, 400)}`,
      details: { sandboxId: effectiveSandboxId, error: err.slice(0, 1200) },
    });
    return { ok: false, error: err, effectiveSandboxId };
  }
  console.log('[CronPersist] post_finally_build OK');
  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.POST_FINALLY_BUILD,
    message: 'post-finally npm run build passed',
    details: { sandboxId: effectiveSandboxId, ok: true },
  });
  return { ok: true, effectiveSandboxId };
}

/** Records post-finally build failure on the last touched plan step for the next cron retry. */
export async function recordPostFinallyBuildFailureStep(params: {
  planId: string;
  siteId: string;
  instanceId: string;
  stepId: string;
  error: string;
}): Promise<void> {
  'use step';
  const { planId, siteId, instanceId, stepId, error } = params;
  await updateInstancePlanCore({
    plan_id: planId,
    site_id: siteId,
    instance_id: instanceId,
    steps: [
      {
        id: stepId,
        error_message: `Post-finally npm run build: ${error.slice(0, 1800)}`,
      },
    ],
  });
}

// ─── Step: Get preview URL ───────────────────────────────────────────

export async function getPreviewUrlStep(
  owner: string,
  repo: string,
  branch: string,
  requirementId?: string,
): Promise<string | null> {
  'use step';
  if (!branch || branch === 'main' || branch === 'master') return null;

  // Fast path: the Vercel webhook already persists `preview_url` on
  // `requirement_status` on `deployment.succeeded` (see
  // `src/lib/integrations/vercel/process-webhook.ts`). Reading from the DB
  // returns instantly instead of blocking the workflow — and the sandbox —
  // on GitHub's deployments API for up to 100s while Vercel builds.
  if (requirementId) {
    try {
      const { data } = await supabaseAdmin
        .from('requirement_status')
        .select('preview_url, created_at')
        .eq('requirement_id', requirementId)
        .not('preview_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);
      const fromWebhook = data?.[0]?.preview_url?.trim();
      if (fromWebhook) return fromWebhook;
    } catch (e: unknown) {
      console.warn(
        '[getPreviewUrlStep] webhook-fast-path lookup failed, falling back to poll:',
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Fallback: short GitHub poll for the race where the webhook has not fired
  // yet. Reduced from 20×5s (100s) to 3×2s (6s): keeping the sandbox alive
  // longer does not make Vercel build faster — if the preview is still not
  // ready, the webhook populates the URL async and the next cron tick picks
  // it up via the fast path above.
  return SandboxService.getPreviewUrl(owner, repo, branch, 3, 2000);
}

// ─── Step: Check source code in storage ──────────────────────────────

export async function checkSourceCodeStep(reqId: string): Promise<string | null> {
  'use step';
  const { createClient } = await import('@supabase/supabase-js');
  const repoUrl = process.env.REPOSITORY_SUPABASE_URL;
  const repoKey = process.env.REPOSITORY_SUPABASE_ANON_KEY;
  if (!repoUrl || !repoKey) return null;

  const storageClient = createClient(repoUrl, repoKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = process.env.SUPABASE_BUCKET || 'workspaces';
  const names = [`req-${reqId}_source_code.tar.gz`, `req-${reqId}_source_code.zip`];
  for (const name of names) {
    const { data } = await storageClient.storage.from(bucket).list('', { search: name, limit: 1 });
    if (data?.length) {
      return storageClient.storage.from(bucket).getPublicUrl(name).data.publicUrl;
    }
  }
  return null;
}

// ─── Step: Stop sandbox ──────────────────────────────────────────────

export async function stopSandboxStep(sandboxId: string, audit?: CronAuditContext) {
  'use step';
  let delayMs = 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sandbox = await Sandbox.get({ sandboxId });
      await sandbox.stop();
      console.log(`[CronStep] 🧹 CLEANUP: Sandbox ${sandboxId} stopped`);
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.SANDBOX_STOP,
        message: `Sandbox stopped (${sandboxId})`,
        details: { sandboxId },
      });
      return;
    } catch (e: unknown) {
      if (attempt < 2) {
        console.warn(`[CronStep] 🧹 CLEANUP: Sandbox stop attempt ${attempt + 1} failed (${sandboxId}). Retrying in ${delayMs}ms...`);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      } else {
        /* sandbox may have auto-stopped or failed permanently */
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.SANDBOX_STOP,
          level: 'warn',
          message: `🚨 ZOMBIE ALERT: Sandbox stop skipped or failed (${sandboxId}) after 3 attempts`,
          details: { sandboxId, error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
  }
}

// ─── Step: Extend cron run lock ─────────────────────────────────────
//
// Refreshes `cron_lock_expires_at` while a long durable workflow is still
// running. Call after heavy phases so runs beyond the initial TTL cannot
// overlap with a new cron tick (parallel sandboxes on the same requirement).

export async function extendRunLockStep(
  requirementId: string,
  runId: string | undefined,
  ttlMs: number = CRON_RUN_LOCK_TTL_MS,
): Promise<void> {
  'use step';
  if (!runId) return;
  await _extendRunLockImpl(requirementId, runId, ttlMs);
}

// ─── Step: Release cron run lock ────────────────────────────────────
//
// Thin step wrapper over `releaseRunLock` (from cron-run-lock.ts) so the
// workflow's finally block can call it without hitting the workflow VM's
// `fetch` restriction. Safe to call even when `runId` is absent (no-op).

export async function releaseRunLockStep(
  requirementId: string,
  runId: string | undefined,
): Promise<void> {
  'use step';
  if (!runId) return;
  await _releaseRunLockImpl(requirementId, runId);
}
