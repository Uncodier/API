import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { type CronAuditContext } from '@/lib/services/cron-audit-log';
import { getGitHubBranchPreviewUrl, type PreviewUrlGitRepoKind } from '@/lib/services/sandbox-preview-url';
import {
  buildRequirementBranchName,
  branchBelongsToRequirement,
  extractRequirementIdFromBranch,
} from '@/lib/services/requirement-branch';
import { type GitBinding } from '@/lib/services/requirement-git-binding';
import { sandboxIdentity } from '@/lib/services/sandbox-sdk';
import {
  SANDBOX_VISUAL_PROBE_PORT,
  SANDBOX_WORK_DIR,
} from '@/lib/services/sandbox-constants';
import { stopSandboxQuiet } from '@/lib/services/sandbox-stop';
import { fetchOriginBranch } from '@/lib/services/sandbox-git-identity';
import { clearStuckGitOperationState, decideFeatureBranchAttach, isInvalidOriginBranchName, pushWithRebaseRetry } from '@/lib/services/sandbox-git-push';
import { deleteSandboxAndOrphans } from '@/lib/services/sandbox-lifecycle';

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
  static readonly WORK_DIR = SANDBOX_WORK_DIR;

  /**
   * Port exposed at sandbox creation so host-side puppeteer can reach
   * `next start` via `sandbox.domain(VISUAL_PROBE_PORT)` for per-step visual +
   * client-signal probes. Also used by the runtime probe; sandboxes created
   * before this change will not have the port mapping and will fail visual
   * probes (rebuild to recover).
   */
  static readonly VISUAL_PROBE_PORT = SANDBOX_VISUAL_PROBE_PORT;

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
   * Canonical branch name for a requirement: `feature/req-<uuid>[--<slug>]`.
   * The slug is cosmetic. The UUID is what identifies the requirement and is
   * always extractable with `extractRequirementIdFromBranch`.
   *
   */
  static buildBranchName(requirementId: string, title: string): string {
    return buildRequirementBranchName(requirementId, title);
  }

  /**
   * Returns the requirement UUID encoded in a branch name (new format only).
   */
  static extractRequirementIdFromBranch(branch: string | null | undefined): string | null {
    return extractRequirementIdFromBranch(branch);
  }

  /** Unique requirement branches from requirement_status.repo_url, newest first. */
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
      if (!branch || seen.has(branch)) continue;
      if (!branchBelongsToRequirement(branch, requirementId)) continue;
      seen.add(branch);
      branches.push(branch);
    }
    return branches;
  }

  /**
   * Creates a Vercel Sandbox, clones the central repo, and checks out the
   * correct branch for the requirement.
   *
   * Repo resolution order:
   * 1. `gitBinding` argument (explicit, wins everything).
   * 2. Requirement's `metadata.git` from the database.
   * 3. Env fallback keyed by `instanceType` (applications vs automation).
   *
   * Branch resolution order:
   * 1. Branches from requirement_status.repo_url history (most recent first)
   *    that belong to this requirement (canonical or legacy shape).
   * 2. Fallback: canonical `feature/req-<uuid>[--<slug>]` created from main.
   */
  static async createRequirementSandbox(
    requirementId: string,
    instanceType: string,
    title: string = '',
    audit?: CronAuditContext,
    gitBinding?: GitBinding,
    opts?: { skipSnapshotReuse?: boolean },
  ): Promise<SandboxResult> {
    const { createRequirementSandbox } = await import('@/lib/services/sandbox-provision');
    return createRequirementSandbox(requirementId, instanceType, title, audit, gitBinding, opts);
  }

  /**
   * Finds any remote branch that matches the requirement ID.
   * Useful to prevent creating multiple branches if the title changes slightly.
   */
  static async findRemoteBranchByRequirementId(
    sandbox: Sandbox,
    requirementId: string,
    cwd: string = SandboxService.WORK_DIR,
  ): Promise<string | null> {
    const idStr = String(requirementId || '').trim().toLowerCase();
    if (!idStr) return null;

    const res = await this.runWithCwd(sandbox, 'git', ['ls-remote', '--heads', 'origin'], cwd);
    if (res.exitCode !== 0) return null;

    const output = await res.stdout();
    const lines = output.split('\n').filter(Boolean);

    for (const line of lines) {
      const match = line.match(/refs\/heads\/(.*)$/);
      if (match) {
        const branchName = match[1];
        if (
          branchName.startsWith(`feature/req-${idStr}`) ||
          branchName.startsWith(`req-${idStr}`)
        ) {
          return branchName;
        }
      }
    }

    return null;
  }

  /** True when `origin/<branch>` exists on the remote (uses `ls-remote --heads`). */
  static async remoteBranchExists(sandbox: Sandbox, branch: string, cwd: string = SandboxService.WORK_DIR): Promise<boolean> {
    const ls = await SandboxService.runWithCwd(sandbox, 'git', ['ls-remote', '--heads', 'origin', branch], cwd);
    if (ls.exitCode !== 0) return false;
    return (await ls.stdout()).trim().length > 0;
  }

  /**
   * After checkout of a remote-tracking branch, reset the workspace to match origin
   * (recover from stale VM or ensure last pushed commit).
   */
  static async syncTrackedBranchToRemoteTip(sandbox: Sandbox, branch: string): Promise<void> {
    const cwd = SandboxService.WORK_DIR;
    const fetchRes = await fetchOriginBranch(sandbox, branch, cwd);
    if (fetchRes.exitCode !== 0) {
      console.warn('[Sandbox] fetch origin before reset failed — continuing with checkout state');
      return;
    }
    const resetRes = await SandboxService.runCommandInSandbox(
      sandbox,
      'git',
      ['reset', '--hard', `origin/${branch}`],
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
   * `rev-parse --abbrev-ref HEAD` returns the literal `HEAD` in two cases: (1) true
   * detached checkout; (2) an **unborn** branch (no commits yet) where HEAD still
   * symbolically points at refs/heads/<name>. The latter must resolve to the real
   * name (e.g. `main`); otherwise `git push -u origin HEAD` fails on the remote.
   */
  static async getCurrentBranch(sandbox: Sandbox): Promise<string> {
    const cwd = SandboxService.WORK_DIR;
    const res = await SandboxService.runWithCwd(sandbox, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to detect current branch: ${await res.stderr()}`);
    }
    const abbr = (await res.stdout()).trim();
    if (abbr !== 'HEAD') {
      return abbr;
    }
    const sym = await SandboxService.runWithCwd(sandbox, 'git', ['symbolic-ref', '-q', '--short', 'HEAD'], cwd);
    if (sym.exitCode === 0) {
      const name = (await sym.stdout()).trim();
      if (name) {
        return name;
      }
    }
    return 'HEAD';
  }

  /**
   * True when HEAD is not attached to a branch (e.g. right after `git checkout <sha>`).
   * Uses `git symbolic-ref` which is the canonical way to detect detached HEAD —
   * `rev-parse --abbrev-ref HEAD` returns the ambiguous literal string `HEAD` in that case.
   */
  static async isDetachedHead(sandbox: Sandbox): Promise<boolean> {
    const cwd = SandboxService.WORK_DIR;
    const res = await SandboxService.runWithCwd(sandbox, 'git', ['symbolic-ref', '-q', 'HEAD'], cwd);
    return res.exitCode !== 0;
  }

  /** True if working tree has unstaged/staged/untracked changes vs last commit. */
  static async hasWorkingTreeChanges(sandbox: Sandbox): Promise<boolean> {
    const cwd = SandboxService.WORK_DIR;
    const r = await SandboxService.runWithCwd(sandbox, 'git', ['status', '--porcelain'], cwd);
    if (r.exitCode !== 0) return false;
    return ((await r.stdout()).trim().length > 0);
  }

  /** Attach HEAD to feature/{reqId} when on main/master or detached. */
  static async ensureFeatureBranchForCron(
    sandbox: Sandbox,
    requirementId: string,
    title: string,
  ): Promise<void> {
    const cwd = SandboxService.WORK_DIR;
    const detached = await SandboxService.isDetachedHead(sandbox);
    const head = detached ? 'HEAD (detached)' : await SandboxService.getCurrentBranch(sandbox);
    if (!detached && head !== 'main' && head !== 'master') {
      return;
    }

    let featureBranch = await SandboxService.findRemoteBranchByRequirementId(sandbox, requirementId, cwd);
    if (!featureBranch) {
      featureBranch = SandboxService.buildBranchName(requirementId, title);
    }

    console.log(
      `[Sandbox] HEAD is ${head} — switching to "${featureBranch}" before persisting changes (cron)`,
    );

    if (!detached) {
      await fetchOriginBranch(sandbox, featureBranch, cwd);
    }

    const action = decideFeatureBranchAttach({
      detached,
      currentBranch: detached ? 'HEAD' : head,
    });

    if (action === 'noop') return;

    const co = await SandboxService.runWithCwd(sandbox, 'git', ['checkout', '-B', featureBranch], cwd);
    if (co.exitCode !== 0) {
      throw new Error(`Failed to attach HEAD to ${featureBranch}: ${await co.stderr()}`);
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
    const safeTitle = (options.title && String(options.title).trim()) || 'requirement';

    await clearStuckGitOperationState(sandbox, cwd);

    if (options.requirementId) {
      await SandboxService.ensureFeatureBranchForCron(sandbox, options.requirementId, safeTitle);
    }

    if (await SandboxService.isDetachedHead(sandbox)) {
      // Without a requirementId we can't derive a feature-branch name, and pushing
      // `HEAD` to origin fails with "not a full refname". Surface a deterministic
      // error instead of producing the confusing git hint.
      throw new Error(
        'Sandbox HEAD is detached — commitAndPush requires a branch. Pass requirementId to auto-create a feature branch, or have the agent run `git checkout -B <branch>` first.',
      );
    }

    let branch = (await SandboxService.getCurrentBranch(sandbox)).trim();
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

    // Cron: always attach the working tree to the canonical feature ref before measuring / pushing
    // so the local ref matches origin and we are never in a "named HEAD" / whitespace edge case.
    if (options.requirementId) {
      let canPushName = await SandboxService.findRemoteBranchByRequirementId(sandbox, options.requirementId, cwd);
      if (!canPushName) {
        canPushName = SandboxService.buildBranchName(options.requirementId, safeTitle);
      }
      const att = await SandboxService.runWithCwd(sandbox, 'git', ['checkout', '-B', canPushName], cwd);
      if (att.exitCode !== 0) {
        throw new Error(
          `Could not attach HEAD to feature branch for push: ${canPushName} — ${await att.stderr()}`,
        );
      }
    }

    branch = (await SandboxService.getCurrentBranch(sandbox)).trim();
    if (isInvalidOriginBranchName(branch) && !options.requirementId) {
      throw new Error(
        'Cannot push: current branch is not a valid ref name. Pass requirementId, or run `git checkout -B <feature-branch>`.',
      );
    }
    aheadCount = await SandboxService.countCommitsAheadOfRemote(sandbox, branch, cwd);

    if (aheadCount === 0) {
      console.warn('[Sandbox] No commits ahead of remote after commit attempt — nothing to push');
      return { branch, pushed: false, commitCount: 0 };
    }

    let pushName = branch;
    if (options.requirementId) {
      pushName = await SandboxService.findRemoteBranchByRequirementId(sandbox, options.requirementId, cwd) 
        || SandboxService.buildBranchName(options.requirementId, safeTitle);
    }
    if (isInvalidOriginBranchName(pushName)) {
      throw new Error(
        'Cannot push: invalid target branch name (empty, HEAD, or unknown). The workspace must be on a real branch for origin.',
      );
    }

    console.log(`[Sandbox] ${aheadCount} commit(s) ahead of remote on ${branch}, pushing as ${pushName}...`);
    const pushed = await pushWithRebaseRetry(sandbox, pushName, cwd);
    if (!pushed.ok) {
      throw new Error(`Failed to push branch ${pushName}: ${pushed.stderr}`);
    }

    const finalAhead = pushed.rebased
      ? await SandboxService.countCommitsAheadOfRemote(sandbox, branch, cwd)
      : aheadCount;
    console.log(
      `[Sandbox] Successfully pushed ${aheadCount} commit(s) to ${pushName}${pushed.rebased ? ' (after rebase on origin)' : ''}`,
    );
    return { branch, pushed: true, commitCount: pushed.rebased ? Math.max(finalAhead, 0) : aheadCount };
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
    const id = sandboxIdentity(sandbox);
    if (id) {
      await deleteSandboxAndOrphans(id);
      return;
    }
    await stopSandboxQuiet(sandbox);
  }
}
