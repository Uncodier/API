'use step';
/**
 * Durable workflow steps: HTTP validation + requirement_status finalization.
 * Split from cron-steps.ts to keep file size manageable.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
// NOTE: Import from `@/lib/tools/...` (not the sibling route folder) so the
// Vercel Workflow bundler doesn't co-bundle `requirement_status/route.ts`
// (which imports `next/server` and crashes with `__dirname is not defined`).
import { createRequirementStatusCore } from '@/lib/tools/requirement-status-core';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { parseGithubTreeUrl, branchBelongsToRequirement } from '@/lib/services/requirement-branch';
import { getRequirementGitBinding } from '@/lib/services/requirement-git-binding';
import { canCloseRequirement } from '@/lib/services/requirement-flow-engine';

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
  repoUrl?: string;
  previewUrl?: string;
  sourceCodeUrl?: string;
  didPush: boolean;
  planCompleted?: boolean;
  repoOk?: boolean;
  previewOk?: boolean;
  smokeError?: string;
  postFinallyBuildError?: string;
  audit?: CronAuditContext;
}): Promise<{ effectiveStatus: 'done' | 'in-progress' | 'blocked' }> {
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
    repoOk,
    previewOk,
    smokeError,
    postFinallyBuildError,
    audit,
  } = params;

  const smokeOk = !smokeError;

  const { data: existing } = await supabaseAdmin
    .from('requirement_status')
    .select('id, status, message, repo_url, preview_url, source_code, updated_at')
    .eq('requirement_id', reqId)
    .eq('instance_id', instanceId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  type ExistingRow = {
    id: string;
    status?: string | null;
    message?: string | null;
    repo_url?: string | null;
    preview_url?: string | null;
    source_code?: string | null;
    updated_at?: string | null;
  } | null;

  const row = existing as ExistingRow;

  // If a prior step in the same workflow tick recorded a 'blocked' status
  // (e.g. orchestrator-no-plan, re-plan loop guard), preserve it. Flipping
  // it back to 'in-progress' would let the cron route pick the requirement
  // up again on the next tick (its filter is `status in [backlog, in-progress]`),
  // defeating the blocker and re-entering the same failure loop. We use a
  // short recency window so an older 'blocked' row from a previous day does
  // not permanently freeze the requirement — only this-cycle blockers win.
  const BLOCKED_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  const existingUpdatedAtMs = row?.updated_at ? Date.parse(row.updated_at) : NaN;
  const existingIsFreshBlocked =
    row?.status === 'blocked' &&
    Number.isFinite(existingUpdatedAtMs) &&
    Date.now() - existingUpdatedAtMs < BLOCKED_WINDOW_MS;

  if (existingIsFreshBlocked) {
    console.log(
      `[CronStep] Preserving fresh 'blocked' status on requirement_status ${row!.id} — not overwriting with cycle finalize.`,
    );
    await logCronInfrastructureEvent(audit ?? { instanceId, siteId: site_id }, {
      event: CronInfraEvent.FINAL_STATUS,
      level: 'warn',
      message: "Finalize skipped: an in-cycle 'blocked' status is preserved for human intervention.",
      details: {
        preserved_status: 'blocked',
        existing_status_id: row!.id,
        existing_message: row!.message ?? null,
      },
    });
    return { effectiveStatus: 'blocked' };
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
  let isComplete =
    !!planCompleted &&
    didPush &&
    !!mergedPreviewUrl &&
    effectivePreviewOk &&
    !!repoOk &&
    smokeOk &&
    !postFinallyBuildError &&
    hasSourceArchive;

  const missingParts: string[] = [];
  if (!planCompleted) missingParts.push('plan not completed');
  if (!didPush) missingParts.push('no push this cycle');
  if (!mergedPreviewUrl) missingParts.push('no preview_url');
  if (mergedPreviewUrl && !effectivePreviewOk) missingParts.push('preview_url returns error/404');
  if (repoUrl && !repoOk) missingParts.push('repo_url returns error/404');
  if (!hasSourceArchive) missingParts.push('no source_code archive in storage');
  if (smokeError) missingParts.push(`smoke test: ${smokeError}`);
  if (postFinallyBuildError) missingParts.push(`post-finally build: ${postFinallyBuildError.slice(0, 200)}`);

  if (isComplete) {
    const closeCheck = await canCloseRequirement(reqId);
    if (!closeCheck.ok) {
      isComplete = false;
      missingParts.push(`backlog not complete: ${closeCheck.reason}`);
    }
  }

  const effectiveStatus = isComplete ? 'done' : 'in-progress';

  const mergedRepoUrl = didPush ? (repoUrl || null) : row?.repo_url ?? null;

  const statusPayload = {
    repo_url: mergedRepoUrl,
    preview_url: mergedPreviewUrl,
    source_code: mergedSourceCode,
    status: effectiveStatus,
    message: isComplete
      ? `Cycle complete. Repo: ${repoUrl} | Preview: ${mergedPreviewUrl} | Source: ${mergedSourceCode}`
      : `In progress — missing: ${missingParts.join(', ')}. Will retry next cycle.`,
  };

  if (existing?.id) {
    await supabaseAdmin
      .from('requirement_status')
      .update({ ...statusPayload, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    console.log(
      `[CronStep] Updated requirement_status ${existing.id} → ${effectiveStatus} | preview: ${mergedPreviewUrl || 'none'} | source: ${mergedSourceCode ? 'yes' : 'no'}`,
    );
  } else {
    // Note: We don't pass active_sandbox_id here because this is the final status
    // and the sandbox is about to be stopped anyway.
    await createRequirementStatusCore({
      site_id,
      instance_id: instanceId,
      requirement_id: reqId,
      repo_url: statusPayload.repo_url ?? undefined,
      preview_url: statusPayload.preview_url ?? undefined,
      source_code: statusPayload.source_code ?? undefined,
      status: statusPayload.status,
      message: statusPayload.message,
    });
    console.log(
      `[CronStep] Created requirement_status → ${effectiveStatus} | preview: ${mergedPreviewUrl || 'none'} | source: ${mergedSourceCode ? 'yes' : 'no'}`,
    );
  }

  if (isComplete) {
    await supabaseAdmin
      .from('requirements')
      .update({ status: 'done', updated_at: new Date().toISOString() })
      .eq('id', reqId);
    console.log(`[CronStep] Requirement ${reqId} → done`);
  }

  await logCronInfrastructureEvent(audit ?? { instanceId, siteId: site_id }, {
    event: CronInfraEvent.FINAL_STATUS,
    message: `Final requirement_status written: ${effectiveStatus}${isComplete ? ' (requirement done)' : ''}`,
    details: {
      effective_status: effectiveStatus,
      isComplete,
      missingParts,
      didPush,
      planCompleted: !!planCompleted,
    },
  });

  return { effectiveStatus };
}
