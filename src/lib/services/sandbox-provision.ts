import { Sandbox } from '@vercel/sandbox';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { assertPlatformGitLayout } from '@/lib/services/sandbox-git-layout';
import {
  getRequirementGitBinding,
  resolveDefaultGitBinding,
  type GitBinding,
} from '@/lib/services/requirement-git-binding';
import { persistActiveSandboxId } from '@/lib/tools/requirement-status-core';
import { sandboxIdentity, sandboxSdkMajor } from '@/lib/services/sandbox-sdk';
import {
  SANDBOX_EXTEND_AFTER_CREATE_MS,
  SANDBOX_WORK_DIR,
  requirementSandboxName,
} from '@/lib/services/sandbox-constants';
import { deleteSandboxAndOrphans } from '@/lib/services/sandbox-lifecycle';
import { ensureNpmDeps } from '@/lib/services/sandbox-npm';
import { fetchOriginBranch, installGitIdentity } from '@/lib/services/sandbox-git-identity';
import { buildSandboxCreateParams, requirementSandboxTags } from '@/lib/services/sandbox-create-params';
import { getOrCreateRequirementSandbox } from '@/lib/services/sandbox-get-or-create';
import { cloneRepoIntoWorkDir } from '@/lib/services/sandbox-git-clone';
import { SandboxService, type SandboxResult } from '@/lib/services/sandbox-service';

export async function createRequirementSandbox(
  requirementId: string,
  instanceType: string,
  title: string = '',
  audit?: CronAuditContext,
  gitBinding?: GitBinding,
  opts?: { skipSnapshotReuse?: boolean },
): Promise<SandboxResult> {
  const auditCtx: CronAuditContext | undefined = audit?.siteId
    ? { ...audit, requirementId: audit.requirementId ?? requirementId }
    : undefined;

  const githubToken = process.env.GITHUB_TOKEN?.trim();
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN environment variable is required.');
  }

  const binding =
    gitBinding ??
    (await getRequirementGitBinding(requirementId, instanceType).catch(() =>
      resolveDefaultGitBinding(instanceType),
    ));

  const gitOrg = binding.org;
  const repoName = binding.repo;
  if (!gitOrg || !repoName) {
    throw new Error(
      'Git binding is incomplete: requirements.metadata.git (or env GIT_ORG + GIT_APPLICATIONS_REPO/GIT_AUTOMATIONS_REPO) must be set.',
    );
  }

  const repoUrlPlain = `https://github.com/${gitOrg}/${repoName}.git`;
  const authRepoUrl = `https://x-access-token:${githubToken}@github.com/${gitOrg}/${repoName}.git`;
  const workDir = SANDBOX_WORK_DIR;
  const sandboxName = requirementSandboxName(requirementId, auditCtx?.instanceId);
  const tags = requirementSandboxTags(requirementId, auditCtx?.instanceId);

  let sandbox: Sandbox | undefined;
  const named = await getOrCreateRequirementSandbox({
    name: sandboxName,
    tags,
    authRepoUrl,
  });
  if (named) {
    sandbox = named.sandbox;
    console.log(`[Sandbox] getOrCreate ${named.created ? 'created' : 'resumed'} ${sandboxName}`);
  }

  if (!sandbox && !opts?.skipSnapshotReuse && sandboxSdkMajor() < 3) {
    try {
      const { tryStartFromPersistedSnapshot } = await import('@/lib/services/sandbox-persisted-snapshot');
      const fromSnap = await tryStartFromPersistedSnapshot({
        requirementId,
        instanceType,
        title,
        binding,
        githubToken,
        auditCtx,
      });
      if (fromSnap) return fromSnap;
    } catch (e: unknown) {
      console.warn('[Sandbox] persisted snapshot bootstrap error:', e instanceof Error ? e.message : e);
    }
  }

  console.log('[Sandbox] Creating sandbox...');
  try {
    if (!sandbox) {
      const { tryForkFromBase } = await import('@/lib/services/sandbox-base-fork');
      sandbox = await tryForkFromBase({
        requirementId,
        instanceId: auditCtx?.instanceId,
        instanceType,
      }) ?? undefined;
      if (sandbox) console.log('[Sandbox] Created from base fork');
    }
  } catch {
    /* fork is optional */
  }

  try {
    if (!sandbox) {
      const useV3Clone = sandboxSdkMajor() >= 3;
      sandbox = await Sandbox.create(buildSandboxCreateParams({
        name: sandboxName,
        tags,
        coldCreate: true,
        git: useV3Clone
          ? undefined
          : {
              url: repoUrlPlain,
              username: 'x-access-token',
              password: githubToken,
              depth: 1,
            },
      }) as Record<string, unknown>);
      if (useV3Clone && sandbox) {
        await cloneRepoIntoWorkDir(sandbox, authRepoUrl, workDir);
      }
    }
    if (!sandbox) throw new Error('Sandbox.create() returned empty handle');
    console.log('[Sandbox] Sandbox created successfully');

    if (auditCtx?.instanceId) {
      await persistActiveSandboxId(requirementId, auditCtx.instanceId, sandboxIdentity(sandbox), auditCtx.siteId)
        .catch((e) => console.error('[Sandbox] Failed to persist active_sandbox_id:', e));
    }
  } catch (err: unknown) {
    const anyErr = err as { message?: string; json?: unknown; text?: unknown };
    console.error('[Sandbox] Sandbox.create() failed:', anyErr?.message || err);
    if (anyErr.json) console.error('[Sandbox] Sandbox.create() JSON detail:', anyErr.json);
    if (anyErr.text) console.error('[Sandbox] Sandbox.create() text detail:', anyErr.text);
    throw new Error(`Sandbox.create() failed: ${anyErr?.message || 'Unknown error'} ${anyErr.text ? JSON.stringify(anyErr.text) : ''}`);
  }

  try {
    try {
      await sandbox.extendTimeout(SANDBOX_EXTEND_AFTER_CREATE_MS);
    } catch (e: unknown) {
      console.warn('[Sandbox] extendTimeout after create failed:', e instanceof Error ? e.message : e);
    }

    await logCronInfrastructureEvent(auditCtx, {
      event: CronInfraEvent.SANDBOX_VM_CREATED,
      message: 'Vercel Sandbox VM created',
      details: { requirementId, instanceType },
    });

    await installGitIdentity(sandbox, authRepoUrl, workDir);
    const fetchRes = await fetchOriginBranch(sandbox, null, workDir);
    if (fetchRes.exitCode !== 0) {
      throw new Error(`Failed to fetch repository: ${fetchRes.stderr}`);
    }

    const knownBranches = await SandboxService.getKnownBranches(requirementId);
    console.log(`[Sandbox] Known branches for req ${requirementId}:`, knownBranches);

    for (const branch of knownBranches) {
      const checkRes = await sandbox.runCommand({
        cmd: 'git',
        args: ['rev-parse', '--verify', `origin/${branch}`],
        cwd: workDir,
      });
      if (checkRes.exitCode === 0) {
        console.log(`[Sandbox] Checking out existing branch: ${branch}`);
        await sandbox.runCommand({ cmd: 'git', args: ['checkout', '--track', `origin/${branch}`], cwd: workDir });
        await SandboxService.syncTrackedBranchToRemoteTip(sandbox, branch);
        await ensureNpmDeps(sandbox, workDir);
        await assertPlatformGitLayout(sandbox);
        await logCronInfrastructureEvent(auditCtx, {
          event: CronInfraEvent.GIT_WORKSPACE_READY,
          message: `Git workspace ready (existing branch ${branch})`,
          details: {
            requirementId,
            branchName: branch,
            isNewBranch: false,
            workDir,
            repo: `${gitOrg}/${repoName}`,
            git: 'source_git_fetch_checkout_npm_install',
          },
        });
        return { sandbox, branchName: branch, workDir, isNewBranch: false, instanceType };
      }
      console.log(`[Sandbox] Branch ${branch} not found on remote, trying next...`);
    }

    let newBranch = await SandboxService.findRemoteBranchByRequirementId(sandbox, requirementId, workDir);
    let remoteExists = false;

    if (newBranch) {
      remoteExists = true;
    } else {
      newBranch = SandboxService.buildBranchName(requirementId, title);
      remoteExists = await SandboxService.remoteBranchExists(sandbox, newBranch, workDir);
    }

    if (remoteExists) {
      console.log(`[Sandbox] No branch in DB history but ${newBranch} exists on origin — tracking remote to avoid divergence`);
      const trackRes = await sandbox.runCommand({
        cmd: 'git',
        args: ['checkout', '--track', `origin/${newBranch}`],
        cwd: workDir,
      });
      if (trackRes.exitCode !== 0) {
        const fallback = await sandbox.runCommand({
          cmd: 'git',
          args: ['checkout', '-b', newBranch, `origin/${newBranch}`],
          cwd: workDir,
        });
        if (fallback.exitCode !== 0) {
          throw new Error(`Failed to checkout existing origin/${newBranch}: ${await fallback.stderr()}`);
        }
      }
      await SandboxService.syncTrackedBranchToRemoteTip(sandbox, newBranch);
      await ensureNpmDeps(sandbox, workDir);
      await assertPlatformGitLayout(sandbox);
      await logCronInfrastructureEvent(auditCtx, {
        event: CronInfraEvent.GIT_WORKSPACE_READY,
        message: `Git workspace ready (recovered branch ${newBranch} from origin)`,
        details: {
          requirementId,
          branchName: newBranch,
          isNewBranch: false,
          workDir,
          repo: `${gitOrg}/${repoName}`,
          git: 'source_git_recover_remote_branch_npm_install',
        },
      });
      return { sandbox, branchName: newBranch, workDir, isNewBranch: false, instanceType };
    }

    console.log(`[Sandbox] No existing branch found, creating: ${newBranch}`);
    const createRes = await sandbox.runCommand({ cmd: 'git', args: ['checkout', '-b', newBranch], cwd: workDir });
    if (createRes.exitCode !== 0) {
      throw new Error(`Failed to create branch ${newBranch}: ${await createRes.stderr()}`);
    }

    await ensureNpmDeps(sandbox, workDir);
    await assertPlatformGitLayout(sandbox);
    await logCronInfrastructureEvent(auditCtx, {
      event: CronInfraEvent.GIT_WORKSPACE_READY,
      message: `Git workspace ready (new branch ${newBranch})`,
      details: {
        requirementId,
        branchName: newBranch,
        isNewBranch: true,
        workDir,
        repo: `${gitOrg}/${repoName}`,
        git: 'source_git_new_branch_npm_install',
      },
    });
    return { sandbox, branchName: newBranch, workDir, isNewBranch: true, instanceType };
  } catch (setupErr: unknown) {
    console.warn(
      '[Sandbox] Workspace setup failed after VM create; deleting sandbox so the next cron does not resume a bad snapshot:',
      setupErr instanceof Error ? setupErr.message : setupErr,
    );
    if (sandbox) {
      await deleteSandboxAndOrphans(sandboxIdentity(sandbox) || requirementSandboxName(requirementId, auditCtx?.instanceId));
    }
    throw setupErr;
  }
}
