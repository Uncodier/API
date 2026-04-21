import { Sandbox } from '@vercel/sandbox';
import { createRequirementStatusCore } from '@/app/api/agents/tools/requirement_status/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { logInstancePreviewUrlRecorded } from '@/lib/services/cron-audit-log';
import { SandboxService } from '@/lib/services/sandbox-service';
import { assertPlatformGitLayout } from '@/lib/services/sandbox-git-layout';
import { validateNpmRepoForVercelDeploy } from './vercel-npm-repo-guard';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import {
  getRequirementGitBinding,
  resolveDefaultGitBinding,
  gitBindingBranchTreeUrl,
  instanceTypeFromGitKind,
  type GitBinding,
  type GitBindingKind,
} from '@/lib/services/requirement-git-binding';
import { branchBelongsToRequirement } from '@/lib/services/requirement-branch';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves site_id for requirement_status writes when the requirement row lacks site_id
 * or the caller did not pass it (common when toolsCtx.site_id is omitted).
 */
export async function resolveSiteIdForRequirementStatus(params: {
  requirementId: string;
  siteId?: string;
  instanceId?: string;
}): Promise<string | null> {
  if (params.siteId?.trim()) {
    return params.siteId.trim();
  }
  const { data: req } = await supabaseAdmin
    .from('requirements')
    .select('site_id')
    .eq('id', params.requirementId)
    .maybeSingle();
  if (req?.site_id) {
    return req.site_id;
  }
  const iid = params.instanceId?.trim();
  if (iid && UUID_RE.test(iid)) {
    const { data: robot } = await supabaseAdmin
      .from('robot_instances')
      .select('site_id')
      .eq('id', iid)
      .maybeSingle();
    if (robot?.site_id) {
      return robot.site_id;
    }
    const { data: remote } = await supabaseAdmin
      .from('remote_instances')
      .select('site_id')
      .eq('id', iid)
      .maybeSingle();
    if (remote?.site_id) {
      return remote.site_id;
    }
  }
  return null;
}

export type GitRepoKind = 'applications' | 'automation';

/**
 * @deprecated Prefer `resolveGitBindingForRequirement` so org/repo/default_branch
 * come from `requirements.metadata.git` (source of truth), not env vars. Kept
 * for back-compat with older call sites during rollout.
 */
export function repoNameForGitRepoKind(gitRepoKind: GitRepoKind = 'applications'): string {
  return gitRepoKind === 'automation'
    ? process.env.GIT_AUTOMATIONS_REPO || 'automations'
    : process.env.GIT_APPLICATIONS_REPO || 'apps';
}

/**
 * Resolves the full git binding (org/repo/default_branch) for a requirement,
 * preferring persisted metadata over env fallback. Never throws — falls back
 * to env resolution when the requirement can't be read.
 */
export async function resolveGitBindingForRequirement(
  requirementId: string,
  gitRepoKind: GitRepoKind = 'applications',
): Promise<GitBinding> {
  const instanceType = instanceTypeFromGitKind(gitRepoKind as GitBindingKind);
  try {
    return await getRequirementGitBinding(requirementId, instanceType);
  } catch {
    return resolveDefaultGitBinding(instanceType);
  }
}

/**
 * Updates the latest requirement_status row for this requirement (optionally scoped to instance_id)
 * with repo_url and, when resolvable, preview_url (Vercel preview via GitHub API).
 * Does not insert rows — only PATCH when a row exists.
 */
export async function syncLatestRequirementStatusWithPreview(params: {
  requirementId: string;
  branch: string;
  siteId?: string;
  instanceId?: string;
  gitRepoKind?: GitRepoKind;
  /** Explicit binding (skips DB read). When absent, resolves from requirement metadata + env fallback. */
  gitBinding?: GitBinding;
  /**
   * When set with `use_resolved_preview_only`, skips getPreviewUrl and uses this value for preview_url
   * (omit column update when null).
   */
  preview_url_resolved?: string | null;
  /** When true, preview_url comes only from preview_url_resolved (post-deploy poll path). */
  use_resolved_preview_only?: boolean;
  /**
   * When false, computes repo_url/preview_url but does not write to DB (caller persists with
   * `patchLatestRequirementStatusColumns`, e.g. sandbox_push_checkpoint after source upload).
   */
  persist?: boolean;
}): Promise<{ updated: boolean; preview_url: string | null; repo_url: string }> {
  const {
    requirementId,
    branch,
    siteId,
    instanceId,
    gitRepoKind = 'applications',
    gitBinding,
    preview_url_resolved,
    use_resolved_preview_only,
    persist = true,
  } = params;
  const binding = gitBinding ?? (await resolveGitBindingForRequirement(requirementId, gitRepoKind));
  const repo_url = gitBindingBranchTreeUrl(binding, branch);

  // Soft consistency check: the branch being synced should encode this
  // requirement's UUID (or match the legacy short-id). Logged only — actual
  // enforcement happens at `validateDeliverablesStep` / `createFinalStatusStep`
  // behind the REQUIREMENT_GIT_STRICT flag.
  if (branch && !branchBelongsToRequirement(branch, requirementId)) {
    console.warn(
      `[RequirementStatusSync] Branch "${branch}" does not encode requirement "${requirementId}" (non-canonical). Sync will still write repo_url but validation may reject this pair.`,
    );
  }

  const kindForPreview: GitRepoKind = binding.kind === 'automation' ? 'automation' : 'applications';
  let preview_url: string | null = null;
  if (use_resolved_preview_only) {
    preview_url = preview_url_resolved ?? null;
  } else if (branch && branch !== binding.default_branch && branch !== 'main' && branch !== 'master') {
    try {
      preview_url = await SandboxService.getPreviewUrl(binding.org, binding.repo, branch, 20, 5000, kindForPreview);
    } catch (e: unknown) {
      console.warn('[RequirementStatusSync] getPreviewUrl failed:', e instanceof Error ? e.message : e);
    }
  }

  const resolvedSiteId = await resolveSiteIdForRequirementStatus({
    requirementId,
    siteId,
    instanceId,
  });

  if (!resolvedSiteId) {
    console.warn('[RequirementStatusSync] No site_id; skip DB update for', requirementId);
    return { updated: false, preview_url, repo_url };
  }

  if (!persist) {
    return { updated: false, preview_url, repo_url };
  }

  let q = supabaseAdmin
    .from('requirement_status')
    .select('id')
    .eq('requirement_id', requirementId)
    .order('created_at', { ascending: false })
    .limit(1);

  const validInstance = instanceId && UUID_RE.test(instanceId) ? instanceId : null;
  if (validInstance) {
    q = q.eq('instance_id', validInstance);
  }

  const { data: rows, error: selErr } = await q;
  if (selErr) {
    console.warn('[RequirementStatusSync] Select failed:', selErr.message);
    return { updated: false, preview_url, repo_url };
  }

  const rowId = rows?.[0]?.id;
  if (!rowId) {
    console.warn('[RequirementStatusSync] No requirement_status row to update for', requirementId);
    return { updated: false, preview_url, repo_url };
  }

  const patch: Record<string, string> = {
    repo_url,
    updated_at: new Date().toISOString(),
  };
  if (preview_url !== null && preview_url !== '') {
    patch.preview_url = preview_url;
  }

  const { error: upErr } = await supabaseAdmin.from('requirement_status').update(patch).eq('id', rowId);
  if (upErr) {
    console.warn('[RequirementStatusSync] Update failed:', upErr.message);
    return { updated: false, preview_url, repo_url };
  }

  if (preview_url) {
    await logInstancePreviewUrlRecorded({
      siteId: resolvedSiteId,
      instanceId: validInstance ?? instanceId ?? null,
      requirementId,
      previewUrl: preview_url,
      context: 'requirement_status_sync',
      repoUrl: repo_url,
    });
  }

  console.log(`[RequirementStatusSync] Updated ${rowId} (repo_url${preview_url !== null ? ' + preview_url' : ''})`);
  return { updated: true, preview_url, repo_url };
}

/**
 * Patches or creates the requirement_status row for this cycle: latest row for requirement_id,
 * preferring instance_id match; falls back to latest row without instance filter if the row was
 * created with null instance_id; inserts when no row exists (e.g. first sandbox_push_checkpoint).
 */
export async function patchLatestRequirementStatusColumns(params: {
  requirementId: string;
  siteId?: string;
  instanceId?: string;
  columns: Partial<Record<'repo_url' | 'preview_url' | 'source_code', string>>;
}): Promise<{ updated: boolean; created?: boolean; error?: string }> {
  const { requirementId, instanceId, columns } = params;
  const resolvedSiteId = await resolveSiteIdForRequirementStatus({
    requirementId,
    siteId: params.siteId,
    instanceId,
  });
  if (!resolvedSiteId) {
    const msg =
      'Cannot resolve site_id (requirements.site_id empty and instance has no site — check requirement and robot_instances).';
    console.warn('[RequirementStatusPatch]', msg, requirementId);
    return { updated: false, error: msg };
  }

  const patch: Record<string, string> = {};
  for (const key of ['repo_url', 'preview_url', 'source_code'] as const) {
    const v = columns[key];
    if (typeof v === 'string' && v.trim() !== '') {
      patch[key] = v.trim();
    }
  }
  if (Object.keys(patch).length === 0) {
    return { updated: false, error: 'No deliverable columns to write (empty patch).' };
  }
  patch.updated_at = new Date().toISOString();

  const validInstance = instanceId && UUID_RE.test(instanceId) ? instanceId : null;

  let rowId: string | null = null;
  if (validInstance) {
    const { data: scoped } = await supabaseAdmin
      .from('requirement_status')
      .select('id')
      .eq('requirement_id', requirementId)
      .eq('instance_id', validInstance)
      .order('created_at', { ascending: false })
      .limit(1);
    rowId = scoped?.[0]?.id ?? null;
  }
  if (!rowId) {
    const { data: anyRow } = await supabaseAdmin
      .from('requirement_status')
      .select('id')
      .eq('requirement_id', requirementId)
      .order('created_at', { ascending: false })
      .limit(1);
    rowId = anyRow?.[0]?.id ?? null;
  }

  if (rowId) {
    const { error: upErr } = await supabaseAdmin.from('requirement_status').update(patch).eq('id', rowId);
    if (upErr) {
      console.warn('[RequirementStatusPatch] Update failed:', upErr.message);
      return { updated: false, error: upErr.message };
    }
    console.log(
      `[RequirementStatusPatch] Updated ${rowId} (${Object.keys(patch)
        .filter((k) => k !== 'updated_at')
        .join(', ')})`,
    );
    if (columns.preview_url?.trim()) {
      await logInstancePreviewUrlRecorded({
        siteId: resolvedSiteId,
        instanceId: validInstance ?? instanceId ?? null,
        requirementId,
        previewUrl: columns.preview_url.trim(),
        context: 'requirement_status_patch',
        repoUrl: columns.repo_url ?? null,
      });
    }
    return { updated: true };
  }

  try {
    await createRequirementStatusCore({
      site_id: resolvedSiteId,
      instance_id: validInstance ?? undefined,
      requirement_id: requirementId,
      repo_url: patch.repo_url,
      preview_url: patch.preview_url,
      source_code: patch.source_code,
      status: 'in-progress',
      message: 'Deliverables recorded from sandbox checkpoint (repo, preview, source archive).',
    });
    console.log(`[RequirementStatusPatch] Inserted requirement_status for ${requirementId}`);
    if (patch.preview_url) {
      await logInstancePreviewUrlRecorded({
        siteId: resolvedSiteId,
        instanceId: validInstance ?? instanceId ?? null,
        requirementId,
        previewUrl: patch.preview_url,
        context: 'requirement_status_insert',
        repoUrl: patch.repo_url ?? null,
      });
    }
    return { updated: true, created: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[RequirementStatusPatch] Insert failed:', msg);
    return { updated: false, error: msg };
  }
}

/**
 * Stages, commits, and pushes from an already-connected sandbox.
 * Used after each plan step outcome and from commitAndPushStep.
 */
export async function commitWorkspaceToOrigin(
  sandbox: Sandbox,
  title: string,
  reqId: string,
  message?: string,
  audit?: CronAuditContext,
  options?: { gitRepoKind?: GitRepoKind; deferRequirementStatusPersist?: boolean },
): Promise<{
  branch: string;
  pushed: boolean;
  commitCount: number;
  /** Present when post-push requirement_status sync ran inside this call (avoids duplicate sync in tools). */
  requirementStatusSync?: Awaited<ReturnType<typeof syncLatestRequirementStatusWithPreview>> | null;
}> {
  try {
    await sandbox.extendTimeout(3 * 60 * 1000);
  } catch {
    /* may be at limit */
  }

  const cwd = SandboxService.WORK_DIR;
  await assertPlatformGitLayout(sandbox);

  const headRes = await sandbox.runCommand({ cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd });
  const headShort = headRes.exitCode === 0 ? (await headRes.stdout()).trim() : '?';

  try {
  // Wrong LLM layout: duplicate or misplaced `app/src/app` — canonical routes are ONLY under repo `src/app/`.
  const fixLayout = await sandbox.runCommand('sh', [
    '-c',
    `cd "${cwd}" || exit 0
if [ -d src/app ] && [ -d app/src/app ] && [ ! -f app/package.json ]; then
  rm -rf app
  echo FIX_RM_DUP
fi
if [ -f package.json ] && [ ! -f app/package.json ] && [ -d app/src/app ] && [ ! -d src/app ]; then
  mkdir -p src
  mv app/src/app src/app
  rm -rf app
  echo FIX_MV_APP
fi
if [ -d src/app ] && [ -d app ] && [ ! -f app/package.json ] && [ ! -d app/src/app ]; then
  rm -rf app
  echo FIX_RM_ORPHAN
fi`,
  ]);
  const fixMsg = (await fixLayout.stdout()).trim();
  if (fixMsg.includes('FIX_RM_DUP')) {
    console.log('[PreCommit] Removed mistaken root app/ (duplicate app/src/app vs src/app)');
  }
  if (fixMsg.includes('FIX_MV_APP')) {
    console.log('[PreCommit] Moved app/src/app → src/app');
  }
  if (fixMsg.includes('FIX_RM_ORPHAN')) {
    console.log('[PreCommit] Removed orphan root app/ (routes live in src/app/ only)');
  }

  let nestedRemoved = 0;
  for (const dir of ['app', 'my-app', 'frontend', 'project', 'web']) {
    const check = await sandbox.runCommand('sh', ['-c', `test -f ${cwd}/${dir}/package.json && echo YES`]);
    if ((await check.stdout()).trim() === 'YES') {
      nestedRemoved++;
      console.log(`[PreCommit] Removing nested project directory: ${dir}/`);
      await sandbox.runCommand('rm', ['-rf', `${cwd}/${dir}`]);
    }
  }
  if (nestedRemoved > 0) {
    console.log(
      `[PreCommit] summary nested_package_roots_removed=${nestedRemoved} (work under mistaken app/ may be deleted before commit — prefer src/app/)`,
    );
  }

  const gitKind = options?.gitRepoKind ?? 'applications';
  const vercelLayoutErr = await validateNpmRepoForVercelDeploy(sandbox, gitKind);
  if (vercelLayoutErr) {
    throw new Error(`[vercel] ${vercelLayoutErr}`);
  }

  const msg = message ?? `Implement ${title} (${reqId})`;
  const result = await SandboxService.commitAndPush(sandbox, {
    message: msg,
    requirementId: reqId,
    title,
  });
  console.log(
    `[CronPersist] commitWorkspaceToOrigin head=${headShort} branch=${result.branch} pushed=${result.pushed} commitCount=${result.commitCount} (correlate with GitHub SHA after push)`,
  );
  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.COMMIT_PUSH,
    message: result.pushed
      ? `Git commit/push: ${result.commitCount} commit(s) on ${result.branch}`
      : `Git commit/push: nothing to push (clean tree) on ${result.branch}`,
    details: {
      branch: result.branch,
      pushed: result.pushed,
      commitCount: result.commitCount,
      headShort,
      commitMessage: msg.slice(0, 200),
    },
  });

  const gitRepoKind = options?.gitRepoKind ?? 'applications';
  const persistStatus = !options?.deferRequirementStatusPersist;
  let requirementStatusSync: Awaited<ReturnType<typeof syncLatestRequirementStatusWithPreview>> | null = null;
  if (result.pushed && audit?.siteId && result.branch) {
    try {
      requirementStatusSync = await syncLatestRequirementStatusWithPreview({
        requirementId: reqId,
        branch: result.branch,
        siteId: audit.siteId,
        instanceId: audit.instanceId,
        gitRepoKind,
        persist: persistStatus,
      });
    } catch (e: unknown) {
      console.warn(
        '[CronPersist] post-push requirement_status sync failed:',
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    branch: result.branch,
    pushed: result.pushed,
    commitCount: result.commitCount,
    requirementStatusSync,
  };
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    const failureKind = classifyGitPushFailure(errMsg);
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.COMMIT_PUSH,
      level: 'error',
      message: `Git commit/push failed${failureKind ? ` (${failureKind})` : ''}: ${errMsg.slice(0, 600)}`,
      details: { headShort, error: errMsg.slice(0, 4000), failureKind },
    });
    throw e;
  }
}

/**
 * Classifies a git push failure from stderr so audit entries are searchable.
 * Returns null when the cause is unknown.
 */
function classifyGitPushFailure(stderr: string): string | null {
  if (!stderr) return null;
  const s = stderr.toLowerCase();
  if (s.includes('[rejected]') || s.includes('non-fast-forward') || s.includes('fetch first')) {
    return 'non_fast_forward';
  }
  if (s.includes('protected branch') || s.includes('gh013') || s.includes('push declined')) {
    return 'protected_branch';
  }
  if (s.includes('authentication failed') || s.includes('invalid credentials') || s.includes('403') || s.includes('permission')) {
    return 'auth';
  }
  if (s.includes('pre-receive hook') || s.includes('hook declined')) {
    return 'server_hook';
  }
  if (s.includes('conflict') && s.includes('rebase')) {
    return 'rebase_conflict';
  }
  if (s.includes('could not resolve host') || s.includes('network')) {
    return 'network';
  }
  return null;
}

export type PlanStepCheckpointKind = 'success' | 'failed_validation' | 'failed_execution';

/**
 * Backs up sandbox work to origin after a successful step only.
 * On failed_validation / failed_execution we do NOT run platform commit/push (policy: use sandbox_push_checkpoint if the agent needs origin updated).
 */
export async function checkpointPlanIteration(
  sandbox: Sandbox,
  title: string,
  reqId: string,
  planStep: any,
  kind: PlanStepCheckpointKind,
  audit?: CronAuditContext,
  opts?: { gitRepoKind?: GitRepoKind },
): Promise<void> {
  if (kind !== 'success') {
    console.log(
      `[CronPersist] checkpoint_skipped policy=no_platform_push_on_failure kind=${kind} step_order=${planStep.order} step_id=${planStep.id}`,
    );
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.CHECKPOINT,
      level: 'warn',
      message: `Platform checkpoint skipped (policy: no push on ${kind})`,
      details: {
        kind,
        step_order: planStep.order,
        step_id: planStep.id,
      },
    });
    return;
  }

  const stepLabel = String(planStep.title || 'step').replace(/\s+/g, ' ').trim().slice(0, 100);
  const body = `WIP: step ${planStep.order} — ${stepLabel}`;
  try {
    await commitWorkspaceToOrigin(sandbox, title, reqId, `${body} (${reqId})`, audit, {
      gitRepoKind: opts?.gitRepoKind,
    });
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.CHECKPOINT,
      message: `Post-step checkpoint finished for step ${planStep.order}`,
      details: { step_order: planStep.order, step_id: planStep.id, step_title: stepLabel },
    });
  } catch (e: any) {
    console.error(
      `[CronPersist] CHECKPOINT_FAILED step=${planStep.order}:`,
      e?.message || e,
      e?.stack,
    );
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.CHECKPOINT,
      level: 'error',
      message: `Checkpoint failed after step ${planStep.order}: ${(e?.message || e).toString().slice(0, 400)}`,
      details: { step_order: planStep.order, step_id: planStep.id },
    });
  }
}
