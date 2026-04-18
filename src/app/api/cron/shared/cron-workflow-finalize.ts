/**
 * Durable workflow steps: HTTP validation + requirement_status finalization.
 * Split from cron-steps.ts to keep file size manageable.
 */
'use step';

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createRequirementStatusCore } from '@/app/api/agents/tools/requirement_status/route';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';

// ─── Step: Validate deliverables (HTTP checks) ──────────────────────

export async function validateDeliverablesStep(params: {
  repoUrl?: string;
  previewUrl?: string;
  audit?: CronAuditContext;
}): Promise<{ repoOk: boolean; previewOk: boolean; previewStatus?: number }> {
  'use step';
  const { repoUrl, previewUrl, audit } = params;
  let repoOk = false;
  let previewOk = false;
  let previewStatus: number | undefined;

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
    level: repoOk && previewOk ? 'info' : 'warn',
    message: `Deliverables check: repo=${repoOk} preview=${previewOk}${previewStatus != null ? ` (HTTP ${previewStatus})` : ''}`,
    details: { repoUrl: repoUrl ?? null, previewUrl: previewUrl ?? null, repoOk, previewOk, previewStatus },
  });

  return { repoOk, previewOk, previewStatus };
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
}): Promise<{ effectiveStatus: 'done' | 'in-progress' }> {
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
    .select('id, repo_url, preview_url, source_code')
    .eq('requirement_id', reqId)
    .eq('instance_id', instanceId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  type ExistingRow = {
    id: string;
    repo_url?: string | null;
    preview_url?: string | null;
    source_code?: string | null;
  } | null;

  const row = existing as ExistingRow;
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
  const isComplete =
    !!planCompleted &&
    didPush &&
    !!mergedPreviewUrl &&
    effectivePreviewOk &&
    !!repoOk &&
    smokeOk &&
    !postFinallyBuildError &&
    hasSourceArchive;
  const effectiveStatus = isComplete ? 'done' : 'in-progress';

  const missingParts: string[] = [];
  if (!planCompleted) missingParts.push('plan not completed');
  if (!didPush) missingParts.push('no push this cycle');
  if (!mergedPreviewUrl) missingParts.push('no preview_url');
  if (mergedPreviewUrl && !effectivePreviewOk) missingParts.push('preview_url returns error/404');
  if (repoUrl && !repoOk) missingParts.push('repo_url returns error/404');
  if (!hasSourceArchive) missingParts.push('no source_code archive in storage');
  if (smokeError) missingParts.push(`smoke test: ${smokeError}`);
  if (postFinallyBuildError) missingParts.push(`post-finally build: ${postFinallyBuildError.slice(0, 200)}`);

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
