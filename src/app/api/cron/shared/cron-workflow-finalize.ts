'use step';
/**
 * Durable workflow steps: HTTP validation + requirement_status finalization.
 * Split from cron-steps.ts to keep file size manageable.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSandboxHandle } from '@/lib/services/sandbox-sdk';
import { shouldTakeManualEndOfWorkflowSnapshot } from '@/lib/services/sandbox-lifecycle';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { parseGithubTreeUrl, branchBelongsToRequirement } from '@/lib/services/requirement-branch';
import { getRequirementGitBinding } from '@/lib/services/requirement-git-binding';
import { canCloseRequirement } from '@/lib/services/requirement-flow-engine';
import { isLightRequirementFlow } from '@/lib/services/requirement-flows';
import { deleteSnapshotQuiet } from '@/lib/services/sandbox-persisted-snapshot';
import { finalizeRequirementExecution } from '@/lib/services/requirement-finalization';

const REQUIREMENT_GIT_STRICT = () => process.env.REQUIREMENT_GIT_STRICT === 'true';

/**
 * Checks that a repo_url + branch pair matches the requirement's persisted
 * git binding AND encodes the requirement UUID in the branch name.
 * Returns a short reason when the pair is inconsistent, or `null` when OK.
 * Always advisory — the caller decides whether to block or just log.
 */
async function checkRepoUrlConsistency(
  requirementId: string,
  repoUrl: string | undefined,
): Promise<string | null> {
  if (!repoUrl || !requirementId) return null;
  const parsed = parseGithubTreeUrl(repoUrl);
  if (!parsed) return 'repo_url is not a github tree URL';

  const binding = await getRequirementGitBinding(requirementId).catch(() => null);
  if (binding) {
    if (binding.org.toLowerCase() !== parsed.org.toLowerCase()) {
      return `repo_url org "${parsed.org}" does not match requirement.metadata.git.org "${binding.org}"`;
    }
    if (binding.repo.toLowerCase() !== parsed.repo.toLowerCase()) {
      return `repo_url repo "${parsed.repo}" does not match requirement.metadata.git.repo "${binding.repo}"`;
    }
  }
  if (!branchBelongsToRequirement(parsed.branch, requirementId)) {
    return `branch "${parsed.branch}" does not encode requirement ${requirementId}`;
  }
  return null;
}

// ─── Step: Validate deliverables (HTTP checks) ──────────────────────

export async function validateDeliverablesStep(params: {
  repoUrl?: string;
  previewUrl?: string;
  requirementId?: string;
  audit?: CronAuditContext;
}): Promise<{ repoOk: boolean; previewOk: boolean; previewStatus?: number; consistencyError?: string }> {
  'use step';
  const { repoUrl, previewUrl, requirementId, audit } = params;
  let repoOk = false;
  let previewOk = false;
  let previewStatus: number | undefined;
  let consistencyError: string | undefined;

  if (repoUrl && requirementId) {
    const mismatch = await checkRepoUrlConsistency(requirementId, repoUrl);
    if (mismatch) {
      consistencyError = mismatch;
      console.warn(
        `[Validation] repo_url inconsistency for req ${requirementId}: ${mismatch}${REQUIREMENT_GIT_STRICT() ? ' (STRICT — will block done)' : ' (advisory)'}`,
      );
    }
  }

  if (repoUrl) {
    try {
      const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/(.+)/);
      if (match) {
        const [, owner, repo, branch] = match;
        const githubToken = process.env.GITHUB_TOKEN;
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`;
        const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
        if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
        const res = await fetch(apiUrl, { headers });
        repoOk = res.status === 200;
        console.log(`[Validation] repo_url (API) ${owner}/${repo}/${branch} → ${res.status} (${repoOk ? 'OK' : 'FAIL'})`);
      } else {
        const res = await fetch(repoUrl, { method: 'HEAD', redirect: 'follow' });
        repoOk = res.status >= 200 && res.status < 400;
        console.log(`[Validation] repo_url ${repoUrl} → ${res.status} (${repoOk ? 'OK' : 'FAIL'})`);
      }
    } catch (err: any) {
      console.warn(`[Validation] repo_url check failed: ${err.message}`);
    }
  }

  if (consistencyError && REQUIREMENT_GIT_STRICT()) {
    repoOk = false;
  }

  if (previewUrl) {
    try {
      const res = await fetch(previewUrl, { redirect: 'follow' });
      previewStatus = res.status;
      previewOk = res.status >= 200 && res.status < 400;
      console.log(`[Validation] preview_url ${previewUrl} → ${res.status} (${previewOk ? 'OK' : 'FAIL'})`);
    } catch (err: any) {
      console.warn(`[Validation] preview_url fetch failed: ${err.message}`);
    }
  }

  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.DELIVERABLES_VALIDATE,
    level: repoOk && previewOk && !consistencyError ? 'info' : 'warn',
    message: `Deliverables check: repo=${repoOk} preview=${previewOk}${previewStatus != null ? ` (HTTP ${previewStatus})` : ''}${consistencyError ? ` | consistency_error=${consistencyError}` : ''}`,
    details: {
      repoUrl: repoUrl ?? null,
      previewUrl: previewUrl ?? null,
      repoOk,
      previewOk,
      previewStatus,
      consistencyError: consistencyError ?? null,
      strict: REQUIREMENT_GIT_STRICT(),
    },
  });

  return { repoOk, previewOk, previewStatus, consistencyError };
}

async function checkPreviewHttpOk(previewUrl: string): Promise<boolean> {
  try {
    const res = await fetch(previewUrl, { redirect: 'follow' });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

// ─── Step: Create final requirement status ───────────────────────────

export async function createFinalStatusStep(params: {
  site_id: string;
  instanceId: string;
  reqId: string;
  sandboxId?: string;
  repoUrl?: string;
  previewUrl?: string;
  sourceCodeUrl?: string;
  didPush: boolean;
  planCompleted?: boolean;
  /** When set, preview/smoke are not required to mark the cycle complete. */
  flowKind?: string;
  repoOk?: boolean;
  previewOk?: boolean;
  smokeError?: string;
  postFinallyBuildError?: string;
  audit?: CronAuditContext;
  expectedExecutionGeneration: number;
  cycleId: string;
}): Promise<{
  effectiveStatus: 'done' | 'in-progress' | 'blocked' | 'on-review';
  state: 'applied' | 'stale';
}> {
  'use step';
  const {
    site_id,
    instanceId,
    reqId,
    repoUrl,
    previewUrl,
    sourceCodeUrl,
    didPush,
    planCompleted,
    flowKind,
    repoOk,
    previewOk,
    smokeError,
    postFinallyBuildError,
    audit,
    expectedExecutionGeneration,
    cycleId,
  } = params;

  const smokeOk = !smokeError;
  const { data: currentRequirement, error: requirementError } =
    await supabaseAdmin
      .from('requirements')
      .select('metadata')
      .eq('id', reqId)
      .maybeSingle();
  if (requirementError) throw requirementError;
  const rawExecutionGeneration =
    currentRequirement?.metadata?.requirement_execution_generation;
  const currentExecutionGeneration =
    typeof rawExecutionGeneration === 'number' &&
    Number.isSafeInteger(rawExecutionGeneration) &&
    rawExecutionGeneration >= 0
      ? rawExecutionGeneration
      : typeof rawExecutionGeneration === 'string' &&
          /^[0-9]{1,9}$/.test(rawExecutionGeneration)
        ? Number.parseInt(rawExecutionGeneration, 10)
        : 0;
  if (
    !currentRequirement ||
    currentExecutionGeneration !== expectedExecutionGeneration
  ) {
    console.warn(
      `[CronStep] Finalize rejected for stale execution generation ${expectedExecutionGeneration}.`,
    );
    return { effectiveStatus: 'in-progress', state: 'stale' };
  }

  const { data: existing } = await supabaseAdmin
    .from('requirement_status')
    .select('id, stage, message, repo_url, preview_url, source_code, updated_at, created_at, snapshot_id')
    .eq('requirement_id', reqId)
    .eq('instance_id', instanceId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  type ExistingRow = {
    id: string;
    stage?: string | null;
    message?: string | null;
    repo_url?: string | null;
    preview_url?: string | null;
    source_code?: string | null;
    updated_at?: string | null;
    created_at?: string | null;
    snapshot_id?: string | null;
  } | null;

  const row = existing as ExistingRow;

  // If a prior step in the same workflow tick recorded a 'blocked' stage
  // (e.g. orchestrator-no-plan, re-plan loop guard), preserve it. Flipping
  // it back to 'in-progress' would let the cron route pick the requirement
  // up again on the next tick (its filter is `status in [backlog, in-progress]`),
  // defeating the blocker and re-entering the same failure loop. We use a
  // short recency window so an older 'blocked' row from a previous day does
  // not permanently freeze the requirement — only this-cycle blockers win.
  // Prefer updated_at; fall back to created_at because createRequirementStatusCore
  // inserts often set only created_at (wrap-up on-review rows).
  const BLOCKED_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  const existingFreshMs = Date.parse(row?.updated_at || row?.created_at || '');
  const existingIsFreshBlocked =
    (row?.stage === 'blocked' || row?.stage === 'needs_review') &&
    Number.isFinite(existingFreshMs) &&
    Date.now() - existingFreshMs < BLOCKED_WINDOW_MS;

  if (existingIsFreshBlocked) {
    console.log(
      `[CronStep] Preserving fresh 'blocked' stage on requirement_status ${row!.id} — not overwriting with cycle finalize.`,
    );
    await logCronInfrastructureEvent(audit ?? { instanceId, siteId: site_id }, {
      event: CronInfraEvent.FINAL_STATUS,
      level: 'warn',
      message: "Finalize skipped: an in-cycle 'blocked' stage is preserved for human intervention.",
      details: {
        preserved_stage: 'blocked',
        existing_status_id: row!.id,
        existing_message: row!.message ?? null,
      },
    });
    return {
      effectiveStatus: row!.stage === 'needs_review' ? 'on-review' : 'blocked',
      state: 'applied',
    };
  }
  const incomingPreview = previewUrl?.trim() || '';
  const incomingSource = sourceCodeUrl?.trim() || '';

  const mergedPreviewUrl = incomingPreview || row?.preview_url || null;
  const mergedSourceCode = incomingSource || row?.source_code || null;

  let effectivePreviewOk = false;
  if (mergedPreviewUrl) {
    if (incomingPreview && mergedPreviewUrl === incomingPreview) {
      effectivePreviewOk = previewOk ?? false;
    } else {
      effectivePreviewOk = await checkPreviewHttpOk(mergedPreviewUrl);
    }
  }

  const hasSourceArchive = !!mergedSourceCode;
  const lightFlow = isLightRequirementFlow(flowKind);
  const buildBlocksComplete = !lightFlow && !!postFinallyBuildError;
  let planCounts = !!planCompleted;
  if (!planCounts && instanceId) {
    const { data: latestPlan } = await supabaseAdmin
      .from('instance_plans')
      .select('status, metadata, completion_reason, updated_at')
      .eq('instance_id', instanceId)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    const { planCancelledBySaneo } = await import('@/lib/helpers/plan-lifecycle');
    const cancelledBySaneo = planCancelledBySaneo(latestPlan);
    if (cancelledBySaneo) {
      planCounts = true;
    }
  }

  let isComplete =
    planCounts &&
    didPush &&
    (lightFlow || (!!mergedPreviewUrl && effectivePreviewOk)) &&
    !!repoOk &&
    (lightFlow || smokeOk) &&
    !buildBlocksComplete &&
    hasSourceArchive;

  const missingParts: string[] = [];
  if (!planCounts) missingParts.push('plan not completed');
  if (!didPush) missingParts.push('no push this cycle');
  if (!lightFlow && !mergedPreviewUrl) missingParts.push('no preview_url');
  if (!lightFlow && mergedPreviewUrl && !effectivePreviewOk) missingParts.push('preview_url returns error/404');
  if (repoUrl && !repoOk) missingParts.push('repo_url returns error/404');
  if (!hasSourceArchive) missingParts.push('no source_code archive in storage');
  if (smokeError) missingParts.push(`smoke test: ${smokeError}`);
  if (buildBlocksComplete && postFinallyBuildError) {
    missingParts.push(`post-finally build: ${postFinallyBuildError.slice(0, 200)}`);
  }

  if (isComplete) {
    const closeCheck = await canCloseRequirement(reqId);
    if (!closeCheck.ok) {
      isComplete = false;
      missingParts.push(`backlog not complete: ${closeCheck.reason}`);
    }
  }

  // Cycle wrap-up may have just written stage='on-review' (delivered or
  // awaiting user permission for another iteration). Do not clobber that with
  // a generic in-progress finalize — only supersede when the requirement is
  // truly complete (done) or the on-review row is stale.
  const existingIsFreshOnReview =
    row?.stage === 'on-review' &&
    Number.isFinite(existingFreshMs) &&
    Date.now() - existingFreshMs < BLOCKED_WINDOW_MS;

  let effectiveStatus: 'done' | 'in-progress' | 'blocked' | 'on-review' = isComplete
    ? 'done'
    : 'in-progress';
  let preserveWrapUpMessage: string | null = null;

  if (!isComplete && existingIsFreshOnReview) {
    // Check if the wrap-up row was created BEFORE our workflow started
    // If it's a legacy row (from a previous workflow execution that didn't
    // finalize properly, or from the user triggering an explicit check), we
    // should not preserve it if we actually ran the orchestrator/agent steps.
    // However, if we skipped the orchestrator and just ran the checks, then
    // it's fine to preserve it.
    effectiveStatus = 'on-review';
    preserveWrapUpMessage = row?.message?.trim() || null;
    console.log(
      `[CronStep] Preserving fresh 'on-review' stage on requirement_status ${row!.id} from cycle wrap-up.`,
    );
  }

  const mergedRepoUrl = didPush ? (repoUrl || null) : row?.repo_url ?? null;

  let newSnapshotId: string | undefined;
  if (!isComplete && params.sandboxId && shouldTakeManualEndOfWorkflowSnapshot()) {
    try {
      const liveSandbox = await getSandboxHandle(params.sandboxId);
      // v1 only: keep a 48h snapshot until the next cron. v3 stop() snapshots.
      const snap = await liveSandbox.snapshot({ expiration: 48 * 60 * 60 * 1000 });
      newSnapshotId = snap.snapshotId;
      console.log(`[CronStep] Took single end-of-workflow snapshot: ${newSnapshotId}`);
    } catch (e: unknown) {
      console.warn(`[CronStep] End-of-workflow snapshot failed for sandbox ${params.sandboxId}:`, e instanceof Error ? e.message : e);
    }
  }

  const finalization = await finalizeRequirementExecution({
    requirementId: reqId,
    siteId: site_id,
    instanceId,
    expectedExecutionGeneration,
    eventId: cycleId,
    existingStatusId: existing?.id,
    status: effectiveStatus,
    message: isComplete
      ? `Cycle complete. Repo: ${repoUrl} | Preview: ${mergedPreviewUrl} | Source: ${mergedSourceCode}`
      : preserveWrapUpMessage ||
        `In progress — missing: ${missingParts.join(', ')}. Will retry next cycle.`,
    repoUrl: mergedRepoUrl,
    previewUrl: mergedPreviewUrl,
    sourceCodeUrl: mergedSourceCode,
    snapshotId: newSnapshotId,
    isComplete,
    markOnReview: !isComplete && effectiveStatus === 'on-review',
  });
  if (finalization.state !== 'applied') {
    if (newSnapshotId) await deleteSnapshotQuiet(newSnapshotId);
    return {
      effectiveStatus: finalization.effectiveStatus,
      state: 'stale',
    };
  }
  console.log(
    `[CronStep] Atomically finalized requirement ${reqId} → ${effectiveStatus} | preview: ${mergedPreviewUrl || 'none'} | source: ${mergedSourceCode ? 'yes' : 'no'}`,
  );

  await logCronInfrastructureEvent(audit ?? { instanceId, siteId: site_id }, {
    event: CronInfraEvent.FINAL_STATUS,
    message: `Final requirement_status written: ${effectiveStatus}${isComplete ? ' (requirement done)' : ''}`,
    details: {
      effective_status: effectiveStatus,
      isComplete,
      missingParts,
      didPush,
      planCompleted: !!planCompleted,
      execution_generation: expectedExecutionGeneration,
    },
  });

  return { effectiveStatus, state: 'applied' };
}
