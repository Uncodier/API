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
  resolveGitBindingForRequirement,
  type GitRepoKind,
} from './status-sync';
import { snapshotAfterSuccessfulPushAndRecreate } from '@/lib/services/sandbox-persisted-snapshot';
import {
  CommitPushTriageError,
  triageGitPushError,
} from '@/lib/services/git-push-error-triage';
import { uploadSandboxSourceArchiveToRepository } from '@/app/api/agents/tools/sandbox/sandbox-source-upload';

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
  /** When the Vercel SDK snapshot stops the prior VM, this is the replacement sandbox (same disk via snapshot). */
  sandboxReplacement?: Sandbox;
  snapshotId?: string;
  source_code?: string;
}> {
  try {
    await sandbox.extendTimeout(3 * 60 * 1000);
  } catch {
    /* may be at limit */
  }

  const priorSandboxId = sandbox.sandboxId;
  let activeSandbox: Sandbox = sandbox;

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

    // Ground-truth mirror: progress.md / feature_list.json / evidence/*.json are
    // synced into the workspace right before the commit so the agent never has
    // to update them manually. Never throws — the commit proceeds even if the
    // mirror fails to write.
    try {
      await syncGroundTruthBeforeCommit({ sandbox, requirementId: reqId, cwd, title, note: msg });
    } catch (e: unknown) {
      console.warn(
        '[PreCommit] Ground-truth sync failed (continuing):',
        e instanceof Error ? e.message : e,
      );
    }

    let result: { branch: string; pushed: boolean; commitCount: number } | undefined;
    let pushError: any;

    try {
      result = await SandboxService.commitAndPush(activeSandbox, {
        message: msg,
        requirementId: reqId,
        title,
      });
    } catch (e: any) {
      pushError = e;
      try {
        const branch = await SandboxService.getCurrentBranch(activeSandbox);
        result = { branch, pushed: false, commitCount: 0 };
      } catch (branchErr) {
        console.warn('[PreCommit] Could not get branch after push error:', branchErr);
      }
    }

    if (result) {
      console.log(
        `[CronPersist] commitWorkspaceToOrigin head=${headShort} branch=${result.branch} pushed=${result.pushed} commitCount=${result.commitCount} (correlate with GitHub SHA after push)`,
      );
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.COMMIT_PUSH,
        message: pushError 
          ? `Git commit/push failed on ${result.branch}`
          : result.pushed
          ? `Git commit/push: ${result.commitCount} commit(s) on ${result.branch}`
          : `Git commit/push: nothing to push (clean tree) on ${result.branch}`,
        details: {
          branch: result.branch,
          pushed: result.pushed,
          commitCount: result.commitCount,
          headShort,
          commitMessage: msg.slice(0, 200),
          error: pushError ? String(pushError) : undefined,
        },
      });
    }

    const gitRepoKind = options?.gitRepoKind ?? 'applications';
    const persistStatus = !options?.deferRequirementStatusPersist;
    let snapshotId: string | undefined;
    const token = process.env.GITHUB_TOKEN;
    
    // We want to snapshot if we pushed successfully OR if we failed to push but have local commits (pushError is set).
    // This preserves the local workspace state (e.g. for rebase_conflict recovery).
    const shouldSnapshot = result && result.branch && token && audit?.siteId && (
      (result.pushed && result.commitCount > 0) || pushError
    );

    if (shouldSnapshot) {
      try {
        const binding = await resolveGitBindingForRequirement(reqId, gitRepoKind);
        const authRepoUrl = `https://x-access-token:${token}@github.com/${binding.org}/${binding.repo}.git`;
        const instanceType = gitRepoKind === 'automation' ? 'automation' : 'applications';
        const recreated = await snapshotAfterSuccessfulPushAndRecreate({
          sandbox: activeSandbox,
          branch: result.branch,
          authRepoUrl,
          requirementId: reqId,
          instanceType,
          title,
          auditCtx: audit,
          isPushRecovery: !!pushError,
        });
        activeSandbox = recreated.sandbox;
        snapshotId = recreated.snapshotId;
      } catch (e: unknown) {
        console.warn('[CronPersist] post-push snapshot/recreate failed:', e instanceof Error ? e.message : e);
      }
    }

    let source_code: string | undefined;
    if (result) {
      try {
        const up = await uploadSandboxSourceArchiveToRepository(activeSandbox, reqId);
        if (up.ok) {
          source_code = up.public_url;
          console.log(`[CronPersist] source archive uploaded: ${up.file} (${up.size_bytes} bytes)`);
        } else {
          console.warn('[CronPersist] source archive upload skipped/failed:', up.error);
        }
      } catch (e: unknown) {
        console.warn('[CronPersist] source archive upload failed:', e instanceof Error ? e.message : e);
      }
    }

    let requirementStatusSync: Awaited<ReturnType<typeof syncLatestRequirementStatusWithPreview>> | null = null;
    if (audit?.siteId && result?.branch) {
      try {
        requirementStatusSync = await syncLatestRequirementStatusWithPreview({
          requirementId: reqId,
          branch: result.branch,
          siteId: audit.siteId,
          instanceId: audit.instanceId,
          gitRepoKind,
          persist: persistStatus,
          snapshot_id: snapshotId,
          source_code,
        });
      } catch (e: unknown) {
        console.warn(
          '[CronPersist] post-push requirement_status sync failed:',
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (pushError) {
      const errMsg = pushError?.message || String(pushError);
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
      
      throw Object.assign(new CommitPushTriageError(tri, { cause: pushError }), {
        sandboxReplacement: activeSandbox.sandboxId !== priorSandboxId ? activeSandbox : undefined,
        snapshotId,
        source_code,
        requirementStatusSync,
        branch: result?.branch
      });
    }

    const sandboxReplacement = activeSandbox.sandboxId !== priorSandboxId ? activeSandbox : undefined;

    return {
      branch: result!.branch,
      pushed: result!.pushed,
      commitCount: result!.commitCount,
      requirementStatusSync,
      ...(sandboxReplacement ? { sandboxReplacement } : {}),
      ...(snapshotId ? { snapshotId } : {}),
      ...(source_code ? { source_code } : {}),
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
