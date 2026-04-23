import { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { assertPlatformGitLayout } from '@/lib/services/sandbox-git-layout';
import { validateNpmRepoForVercelDeploy } from '../vercel-npm-repo-guard';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { syncGroundTruthBeforeCommit } from '@/lib/services/requirement-ground-truth';
import {
  syncLatestRequirementStatusWithPreview,
  type GitRepoKind,
} from './status-sync';
import {
  CommitPushTriageError,
  triageGitPushError,
} from '@/lib/services/git-push-error-triage';

export {
  classifyGitPushFailure,
  type GitPushTriage,
  type GitPushFailureKind,
} from '@/lib/services/git-push-error-triage';

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

    // Ground-truth mirror: progress.md / feature_list.json / evidence/*.json are
    // synced into the workspace right before the commit so the agent never has
    // to update them manually. Never throws — the commit proceeds even if the
    // mirror fails to write.
    try {
      await syncGroundTruthBeforeCommit({ sandbox, requirementId: reqId, cwd, title });
    } catch (e: unknown) {
      console.warn(
        '[PreCommit] Ground-truth sync failed (continuing):',
        e instanceof Error ? e.message : e,
      );
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
    if (e instanceof CommitPushTriageError) {
      throw e;
    }
    const errMsg = e?.message || String(e);
    const tri = triageGitPushError(errMsg);
    const logSummary = tri.agentMessage.replace(/\s+/g, ' ').trim().slice(0, 500);
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.COMMIT_PUSH,
      level: tri.agentActionable ? 'error' : 'warn',
      message: `Git commit/push failed (${tri.failureKind}): ${logSummary}`,
      details: {
        headShort,
        error: errMsg.slice(0, 4000),
        failureKind: tri.failureKind,
        agentActionable: tri.agentActionable,
        agentMessage: tri.agentMessage,
      },
    });
    throw new CommitPushTriageError(tri, { cause: e });
  }
}
