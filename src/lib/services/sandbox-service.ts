import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { getGitHubBranchPreviewUrl, type PreviewUrlGitRepoKind } from '@/lib/services/sandbox-preview-url';
import { assertPlatformGitLayout } from '@/lib/services/sandbox-git-layout';

export interface SandboxResult {
  sandbox: Sandbox;
  branchName: string;
  workDir: string;
  isNewBranch: boolean;
  instanceType: string; // Add instanceType to the result
}

export type CommitAndPushOptions = {
  message?: string;
  /** When set, forces a feature branch off main/master before commit+push (cron). Title may be omitted; slug falls back to "work". */
  requirementId?: string;
  title?: string;
};

export class SandboxService {
  /** Cloned repository root inside the microVM (SDK `source.git` checks out here). */
  static readonly WORK_DIR = '/vercel/sandbox';

  private static readonly SANDBOX_CREATE_TIMEOUT_MS = 15 * 60 * 1000;
  /** Extends VM lifetime right after create, before fetch/npm install. */
  private static readonly EXTEND_AFTER_CREATE_MS = 10 * 60 * 1000;

  /** runCommand with cwd (tuple overload in SDK .d.ts omits cwd). */
  private static runWithCwd(sandbox: Sandbox, command: string, args: string[], cwd: string) {
    return sandbox.runCommand({ cmd: command, args, cwd });
  }

  /**
   * Extract branch name from a GitHub repo_url like
   * https://github.com/makinary/apps/tree/feature/21c35450-wework-clone
   */
  static extractBranchFromRepoUrl(repoUrl: string): string | null {
    const match = repoUrl.match(/\/tree\/(.+)$/);
    return match ? match[1] : null;
  }

  /**
   * Build a branch name following the convention: feature/{shortId}-{slug}
   * e.g. feature/21c35450-wework-clone
   */
  static buildBranchName(requirementId: string, title: string): string {
    const shortId = requirementId.substring(0, 8);
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .substring(0, 40)
      .replace(/-+$/, '');
    const safeSlug = slug || 'work';
    return `feature/${shortId}-${safeSlug}`;
  }

  /**
   * Fetch known branches for a requirement from requirement_status.repo_url history.
   * Returns unique branch names ordered by most recent first.
   */
  static async getKnownBranches(requirementId: string): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('requirement_status')
      .select('repo_url')
      .eq('requirement_id', requirementId)
      .not('repo_url', 'is', null)
      .order('created_at', { ascending: false });

    if (!data || data.length === 0) return [];

    const branches: string[] = [];
    const seen = new Set<string>();
    for (const row of data) {
      const branch = SandboxService.extractBranchFromRepoUrl(row.repo_url);
      if (branch && !seen.has(branch)) {
        seen.add(branch);
        branches.push(branch);
      }
    }
    return branches;
  }

  /**
   * Creates a Vercel Sandbox, clones the central repo, and checks out the
   * correct branch for the requirement.
   *
   * Branch resolution order:
   * 1. Branches from requirement_status.repo_url history (most recent first)
   * 2. Fallback: `feature/{shortId}` created from main
   */
  static async createRequirementSandbox(
    requirementId: string,
    instanceType: string, // Use instanceType to determine repo
    title: string = '',
    audit?: CronAuditContext,
  ): Promise<SandboxResult> {
    const auditCtx: CronAuditContext | undefined = audit?.siteId
      ? { ...audit, requirementId: audit.requirementId ?? requirementId }
      : undefined;

    const githubToken = process.env.GITHUB_TOKEN;
    const gitOrg = process.env.GIT_ORG || 'makinary';
    const repoName = instanceType === 'automation'
      ? process.env.GIT_AUTOMATIONS_REPO
      : process.env.GIT_APPLICATIONS_REPO;

    if (!githubToken || !gitOrg || !repoName) {
      throw new Error(
        'GITHUB_TOKEN, GIT_ORG, and GIT_APPLICATIONS_REPO/GIT_AUTOMATIONS_REPO environment variables are required.',
      );
    }

    const repoUrlPlain = `https://github.com/${gitOrg}/${repoName}.git`;
    const authRepoUrl = `https://x-access-token:${githubToken}@github.com/${gitOrg}/${repoName}.git`;
    const workDir = SandboxService.WORK_DIR;

    console.log('[Sandbox] Creating sandbox (SDK git source)...');
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.create({
        runtime: 'node24',
        timeout: SandboxService.SANDBOX_CREATE_TIMEOUT_MS,
        source: {
          type: 'git',
          url: repoUrlPlain,
          username: 'x-access-token',
          password: githubToken,
        },
      });
      console.log('[Sandbox] Sandbox created successfully');
    } catch (err: any) {
      console.error('[Sandbox] Sandbox.create() failed:', err?.message || err);
      throw new Error(`Sandbox.create() failed: ${err?.message || 'Unknown error'}`);
    }

    try {
      await sandbox.extendTimeout(SandboxService.EXTEND_AFTER_CREATE_MS);
    } catch (e: unknown) {
      console.warn('[Sandbox] extendTimeout after create failed:', e instanceof Error ? e.message : e);
    }

    await logCronInfrastructureEvent(auditCtx, {
      event: CronInfraEvent.SANDBOX_VM_CREATED,
      message: 'Vercel Sandbox VM created',
      details: { requirementId, instanceType },
    });

    await sandbox.runCommand('git', [
      'config', '--global', 'user.name',
      process.env.GIT_AUTHOR_NAME || 'Assistant Runner',
    ]);
    await sandbox.runCommand('git', [
      'config', '--global', 'user.email',
      process.env.GIT_AUTHOR_EMAIL || 'assistant@uncodie.com',
    ]);

    const setRemote = await SandboxService.runWithCwd(sandbox, 'git', ['remote', 'set-url', 'origin', authRepoUrl], workDir);
    if (setRemote.exitCode !== 0) {
      const addRemote = await SandboxService.runWithCwd(sandbox, 'git', ['remote', 'add', 'origin', authRepoUrl], workDir);
      if (addRemote.exitCode !== 0) {
        throw new Error(`Failed to configure git remote: ${await addRemote.stderr()}`);
      }
    }

    const fetchRes = await SandboxService.runWithCwd(sandbox, 'git', ['fetch', '--all'], workDir);
    if (fetchRes.exitCode !== 0) {
      throw new Error(`Failed to fetch repository: ${await fetchRes.stderr()}`);
    }

    // Try known branches from requirement_status history
    const knownBranches = await SandboxService.getKnownBranches(requirementId);
    console.log(`[Sandbox] Known branches for req ${requirementId}:`, knownBranches);

    for (const branch of knownBranches) {
      const checkRes = await SandboxService.runWithCwd(
        sandbox,
        'git',
        ['rev-parse', '--verify', `origin/${branch}`],
        workDir,
      );
      if (checkRes.exitCode === 0) {
        console.log(`[Sandbox] Checking out existing branch: ${branch}`);
        await SandboxService.runWithCwd(sandbox, 'git', ['checkout', '--track', `origin/${branch}`], workDir);
        await SandboxService.syncTrackedBranchToRemoteTip(sandbox, branch);
        await SandboxService.runWithCwd(sandbox, 'npm', ['install'], workDir);
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

    // No known branch — create one with the naming convention
    const newBranch = SandboxService.buildBranchName(requirementId, title || requirementId);
    console.log(`[Sandbox] No existing branch found, creating: ${newBranch}`);

    const createRes = await SandboxService.runWithCwd(sandbox, 'git', ['checkout', '-b', newBranch], workDir);
    if (createRes.exitCode !== 0) {
      throw new Error(`Failed to create branch ${newBranch}: ${await createRes.stderr()}`);
    }

    await SandboxService.runWithCwd(sandbox, 'npm', ['install'], workDir);
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
  }

  /**
   * After checkout of a remote-tracking branch, reset the workspace to match origin
   * (recover from stale VM or ensure last pushed commit).
   */
  static async syncTrackedBranchToRemoteTip(sandbox: Sandbox, branch: string): Promise<void> {
    const cwd = SandboxService.WORK_DIR;
    const fetchRes = await SandboxService.runCommandInSandbox(sandbox, 'git', ['fetch', 'origin'], [], cwd);
    if (fetchRes.exitCode !== 0) {
      console.warn('[Sandbox] fetch origin before reset failed — continuing with checkout state');
      return;
    }
    const resetRes = await SandboxService.runCommandInSandbox(
      sandbox,
      'git',
      ['reset', '--hard', `origin/${branch}`],
      [],
      cwd,
    );
    if (resetRes.exitCode !== 0) {
      console.warn(`[Sandbox] reset --hard origin/${branch} failed — continuing with checkout state`);
    }
  }

  /**
   * Runs a command in the sandbox.
   */
  static async runCommandInSandbox(sandbox: Sandbox, command: string, args: string[] = [], cwd: string = SandboxService.WORK_DIR) {
    const result = await sandbox.runCommand({ cmd: command, args, cwd });

    return {
      stdout: await result.stdout(),
      stderr: await result.stderr(),
      exitCode: result.exitCode,
    };
  }

  /**
   * Commits on HEAD not yet on the remote tracking branch.
   * For a branch that has never been pushed, origin/<branch> does not exist — use origin/main (or master) as base.
   */
  static async countCommitsAheadOfRemote(sandbox: Sandbox, branch: string, cwd: string): Promise<number> {
    const remoteTip = await SandboxService.runWithCwd(sandbox, 'git', ['rev-parse', '--verify', `origin/${branch}`], cwd);
    if (remoteTip.exitCode === 0) {
      const r = await SandboxService.runWithCwd(sandbox, 'git', ['rev-list', '--count', `origin/${branch}..HEAD`], cwd);
      if (r.exitCode !== 0) return 0;
      return parseInt((await r.stdout()).trim(), 10) || 0;
    }
    for (const base of ['origin/main', 'origin/master']) {
      const baseOk = await SandboxService.runWithCwd(sandbox, 'git', ['rev-parse', '--verify', base], cwd);
      if (baseOk.exitCode !== 0) continue;
      const r = await SandboxService.runWithCwd(sandbox, 'git', ['rev-list', '--count', `${base}..HEAD`], cwd);
      if (r.exitCode !== 0) continue;
      return parseInt((await r.stdout()).trim(), 10) || 0;
    }
    return 0;
  }

  /**
   * Returns the current git branch name inside the sandbox.
   */
  static async getCurrentBranch(sandbox: Sandbox): Promise<string> {
    const cwd = SandboxService.WORK_DIR;
    const res = await SandboxService.runWithCwd(sandbox, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to detect current branch: ${await res.stderr()}`);
    }
    return (await res.stdout()).trim();
  }

  /** True if working tree has unstaged/staged/untracked changes vs last commit. */
  static async hasWorkingTreeChanges(sandbox: Sandbox): Promise<boolean> {
    const cwd = SandboxService.WORK_DIR;
    const r = await SandboxService.runWithCwd(sandbox, 'git', ['status', '--porcelain'], cwd);
    if (r.exitCode !== 0) return false;
    return ((await r.stdout()).trim().length > 0);
  }

  /**
   * Cron must not leave work on main/master: push is blocked there. When requirementId is set,
   * move HEAD to feature/{shortId}-{slug} (create or checkout). Preserves the working tree.
   */
  static async ensureFeatureBranchForCron(
    sandbox: Sandbox,
    requirementId: string,
    title: string,
  ): Promise<void> {
    const cwd = SandboxService.WORK_DIR;
    const head = await SandboxService.getCurrentBranch(sandbox);
    if (head !== 'main' && head !== 'master') {
      return;
    }

    const featureBranch = SandboxService.buildBranchName(requirementId, title);
    console.log(
      `[Sandbox] HEAD is ${head} — switching to "${featureBranch}" before persisting changes (cron)`,
    );

    await SandboxService.runWithCwd(sandbox, 'git', ['fetch', 'origin'], cwd);

    const localOk = await SandboxService.runWithCwd(sandbox, 'git', ['rev-parse', '--verify', featureBranch], cwd);
    if (localOk.exitCode === 0) {
      const co = await SandboxService.runWithCwd(sandbox, 'git', ['checkout', featureBranch], cwd);
      if (co.exitCode !== 0) {
        throw new Error(`Failed to checkout local branch ${featureBranch}: ${await co.stderr()}`);
      }
      return;
    }

    const ls = await SandboxService.runWithCwd(sandbox, 'git', ['ls-remote', '--heads', 'origin', featureBranch], cwd);
    if ((await ls.stdout()).trim()) {
      const co = await SandboxService.runWithCwd(
        sandbox,
        'git',
        ['checkout', '-b', featureBranch, `origin/${featureBranch}`],
        cwd,
      );
      if (co.exitCode !== 0) {
        throw new Error(`Failed to checkout origin/${featureBranch}: ${await co.stderr()}`);
      }
      return;
    }

    const co = await SandboxService.runWithCwd(sandbox, 'git', ['checkout', '-b', featureBranch], cwd);
    if (co.exitCode !== 0) {
      throw new Error(`Failed to create branch ${featureBranch}: ${await co.stderr()}`);
    }
  }

  /**
   * Stages changes, commits, and pushes to the origin.
   * Evaluates the repo first: only commits/pushes when there is something to persist
   * (dirty working tree or local commits not on remote).
   */
  static async commitAndPush(
    sandbox: Sandbox,
    options: CommitAndPushOptions = {},
  ): Promise<{ branch: string; pushed: boolean; commitCount: number }> {
    const cwd = SandboxService.WORK_DIR;
    const message = options.message ?? 'Automated commit by Assistant';

    if (options.requirementId) {
      const safeTitle = (options.title && String(options.title).trim()) || 'requirement';
      await SandboxService.ensureFeatureBranchForCron(sandbox, options.requirementId, safeTitle);
    }

    let branch = await SandboxService.getCurrentBranch(sandbox);
    const dirty = await SandboxService.hasWorkingTreeChanges(sandbox);
    let aheadCount = await SandboxService.countCommitsAheadOfRemote(sandbox, branch, cwd);

    if (!dirty && aheadCount === 0) {
      if (branch === 'main' || branch === 'master') {
        const diag = await SandboxService.runCommandInSandbox(sandbox, 'git', ['status', '-sb'], cwd);
        console.log(
          `[Sandbox] Clean on default branch ${branch} — cannot treat as published. status:\\n${diag.stdout.slice(0, 1500)}`,
        );
        return { branch, pushed: false, commitCount: 0 };
      }
      console.log(`[Sandbox] Already synced with origin on ${branch} (clean, nothing ahead)`);
      return { branch, pushed: true, commitCount: 0 };
    }

    if (dirty) {
      console.log('[Sandbox] Working tree has changes — staging and committing');
    } else {
      console.log('[Sandbox] Clean tree but branch is ahead of remote — pushing existing commits');
    }

    if (branch === 'main' || branch === 'master') {
      if (dirty || aheadCount > 0) {
        console.warn(
          `[Sandbox] Still on ${branch} with changes/commits to persist — push is blocked from default branch. Pass requirementId in commit options so a feature branch is created.`,
        );
        await SandboxService.runWithCwd(sandbox, 'git', ['add', '-A'], cwd);
        await SandboxService.runWithCwd(sandbox, 'git', ['commit', '-m', message], cwd);
      }
      return { branch, pushed: false, commitCount: 0 };
    }

    if (dirty) {
      await SandboxService.runWithCwd(sandbox, 'git', ['add', '-A'], cwd);
      const commitRes = await SandboxService.runWithCwd(sandbox, 'git', ['commit', '-m', message], cwd);
      if (commitRes.exitCode === 0) {
        console.log(`[Sandbox] New commit created on ${branch}`);
      } else {
        const errOut = await commitRes.stderr();
        const out = await commitRes.stdout();
        console.warn(
          `[Sandbox] git commit failed or empty (exit ${commitRes.exitCode}). stderr: ${String(errOut).slice(0, 1500)} stdout: ${String(out).slice(0, 500)}`,
        );
      }
    }

    branch = await SandboxService.getCurrentBranch(sandbox);
    aheadCount = await SandboxService.countCommitsAheadOfRemote(sandbox, branch, cwd);

    if (aheadCount === 0) {
      console.warn('[Sandbox] No commits ahead of remote after commit attempt — nothing to push');
      return { branch, pushed: false, commitCount: 0 };
    }

    console.log(`[Sandbox] ${aheadCount} commit(s) ahead of remote on ${branch}, pushing...`);
    const pushRes = await SandboxService.runWithCwd(sandbox, 'git', ['push', '-u', 'origin', branch], cwd);
    if (pushRes.exitCode !== 0) {
      const stderr = await pushRes.stderr();
      throw new Error(`Failed to push branch ${branch}: ${stderr}`);
    }

    console.log(`[Sandbox] Successfully pushed ${aheadCount} commit(s) to ${branch}`);
    return { branch, pushed: true, commitCount: aheadCount };
  }

  /**
   * Gets the Vercel preview URL for a branch from GitHub.
   * Strategy: resolve branch HEAD SHA → check deployments by SHA → fallback to check-runs summary.
   */
  static async getPreviewUrl(
    owner: string,
    repo: string,
    branch: string,
    maxAttempts = 20,
    pollIntervalMs = 5000,
    gitRepoKind?: PreviewUrlGitRepoKind,
  ): Promise<string | null> {
    return getGitHubBranchPreviewUrl(owner, repo, branch, maxAttempts, pollIntervalMs, gitRepoKind);
  }

  /**
   * Destroys the sandbox.
   */
  static async destroySandbox(sandbox: Sandbox) {
    // Current @vercel/sandbox API stops automatically after some time
    // but there isn't a explicit "destroy" if the API doesn't expose it.
    // If there is, it would be called here.
    // As per docs: "Sandboxes automatically stop after 5 minutes." 
    // We will call stop if available or do nothing.
    if ('stop' in sandbox && typeof (sandbox as any).stop === 'function') {
      await (sandbox as any).stop();
    }
  }
}
