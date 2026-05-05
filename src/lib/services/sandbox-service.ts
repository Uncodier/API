import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { getGitHubBranchPreviewUrl, type PreviewUrlGitRepoKind } from '@/lib/services/sandbox-preview-url';
import { assertPlatformGitLayout } from '@/lib/services/sandbox-git-layout';
import {
  buildRequirementBranchName,
  branchBelongsToRequirement,
  extractRequirementIdFromBranch,
} from '@/lib/services/requirement-branch';
import {
  getRequirementGitBinding,
  resolveDefaultGitBinding,
  type GitBinding,
} from '@/lib/services/requirement-git-binding';
import { persistActiveSandboxId } from '@/lib/tools/requirement-status-core';

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

  /**
   * Port exposed at sandbox creation so host-side puppeteer can reach
   * `next start` via `sandbox.domain(VISUAL_PROBE_PORT)` for per-step visual +
   * client-signal probes. Also used by the runtime probe; sandboxes created
   * before this change will not have the port mapping and will fail visual
   * probes (rebuild to recover).
   */
  static readonly VISUAL_PROBE_PORT = 3000;

  private static readonly SANDBOX_CREATE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  /** Extends VM lifetime right after create, before fetch/npm install. */
  private static readonly EXTEND_AFTER_CREATE_MS = 10 * 60 * 1000; // 10 minutes

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
   * Back-compat: the legacy `feature/<8hex>-<slug>` format is still recognised
   * by `getKnownBranches` when reading history, but NEW branches are always
   * emitted in the canonical shape above.
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

  /**
   * Fetch known branches for a requirement from requirement_status.repo_url history.
   * Returns unique branch names ordered by most recent first. Filters to branches
   * that belong to the requirement (either canonical UUID or legacy 8-char match)
   * so stray rows cannot leak unrelated branch names.
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
    instanceType: string, // Use instanceType to determine repo when no binding is given
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
    const workDir = SandboxService.WORK_DIR;

    if (!opts?.skipSnapshotReuse) {
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

    console.log('[Sandbox] Creating sandbox (SDK git source)...');
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.create({
        runtime: 'node24',
        timeout: SandboxService.SANDBOX_CREATE_TIMEOUT_MS,
        ports: [SandboxService.VISUAL_PROBE_PORT],
        source: {
          type: 'git',
          url: repoUrlPlain,
          username: 'x-access-token',
          password: githubToken,
        },
      } as any); // Type assertion added to workaround TS errors
      console.log('[Sandbox] Sandbox created successfully');
      
      if (auditCtx?.instanceId) {
        await persistActiveSandboxId(requirementId, auditCtx.instanceId, sandbox.sandboxId, auditCtx.siteId)
          .catch(e => console.error('[Sandbox] Failed to persist active_sandbox_id:', e));
      }
    } catch (err: any) {
      console.error('[Sandbox] Sandbox.create() failed:', err?.message || err);
      if (err.json) console.error('[Sandbox] Sandbox.create() JSON detail:', err.json);
      if (err.text) console.error('[Sandbox] Sandbox.create() text detail:', err.text);
      throw new Error(`Sandbox.create() failed: ${err?.message || 'Unknown error'} ${err.text ? JSON.stringify(err.text) : ''}`);
    }

    try {
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

    // No known branch in DB — but the canonical name may already exist on origin
    // (previous run pushed without persisting repo_url, manual edit on GitHub,
    // or a concurrent run that just created it). Always consult `origin` by name
    // before branching off main; otherwise we'd push a divergent history and hit
    // a non-fast-forward rejection.
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
      const trackRes = await SandboxService.runWithCwd(
        sandbox,
        'git',
        ['checkout', '--track', `origin/${newBranch}`],
        workDir,
      );
      if (trackRes.exitCode !== 0) {
        const fallback = await SandboxService.runWithCwd(
          sandbox,
          'git',
          ['checkout', '-b', newBranch, `origin/${newBranch}`],
          workDir,
        );
        if (fallback.exitCode !== 0) {
          throw new Error(`Failed to checkout existing origin/${newBranch}: ${await fallback.stderr()}`);
        }
      }
      await SandboxService.syncTrackedBranchToRemoteTip(sandbox, newBranch);
      await SandboxService.runWithCwd(sandbox, 'npm', ['install'], workDir);
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
    } catch (setupErr: unknown) {
      console.warn(
        '[Sandbox] Workspace setup failed after VM create; stopping sandbox:',
        setupErr instanceof Error ? setupErr.message : setupErr,
      );
      await SandboxService.stopSandboxQuiet(sandbox);
      throw setupErr;
    }
  }

  /** Best-effort stop when setup fails after `Sandbox.create` (avoids zombie billing). */
  private static async stopSandboxQuiet(sandbox: Sandbox): Promise<void> {
    let delayMs = 1000;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sandbox.stop();
        return;
      } catch (e: unknown) {
        if (attempt < 2) {
          console.warn(`[Sandbox] 🧹 CLEANUP: stopSandboxQuiet attempt ${attempt + 1} failed for ${sandbox.sandboxId}. Retrying in ${delayMs}ms...`);
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
        } else {
          console.error(`[Sandbox] 🚨 ZOMBIE ALERT: Failed to stop sandbox ${sandbox.sandboxId} after 3 attempts. It may be orphaned.`);
        }
      }
    }
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
    const fetchRes = await SandboxService.runCommandInSandbox(sandbox, 'git', ['fetch', 'origin'], cwd);
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
   * True if the name cannot be used as refs/heads/<name> for `git push` (e.g. missing,
   * the literal "HEAD" with or without bad whitespace, or case-only "head").
   */
  private static isInvalidOriginBranchName(name: string): boolean {
    const b = String(name).trim();
    if (!b) return true;
    if (b === 'HEAD' || b.toLowerCase() === 'head') return true;
    return false;
  }

  /**
   * Clears an incomplete rebase/merge from a previous agent or failed automated push.
   * If `.git/rebase-merge` is left over, a subsequent `git rebase` fails with
   * "there is already a rebase-merge directory", and the next `commitAndPush` can
   * surface unrelated errors (e.g. `HEAD` refspec) in the same log minute.
   */
  private static async clearStuckGitOperationState(sandbox: Sandbox, cwd: string): Promise<void> {
    const sh = `
[ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ] || exit 0
git rebase --abort 2>/dev/null || true
git rebase --quit 2>/dev/null || true
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  rm -rf .git/rebase-merge .git/rebase-apply
fi
[ -f .git/MERGE_HEAD ] && git merge --abort 2>/dev/null || true
exit 0
`;
    await SandboxService.runWithCwd(sandbox, 'sh', ['-c', sh], cwd);
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

  /**
   * Cron must not leave work on main/master or detached HEAD: push is blocked from the
   * default branches and `git push origin HEAD` fails when the remote can't resolve a
   * target ref (common when agents run `git checkout <sha>` inside the sandbox).
   * When requirementId is set, move HEAD to feature/{shortId}-{slug} (create or checkout),
   * preserving the working tree and any commits made while detached.
   */
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

    if (detached) {
      // `git checkout -B` creates the branch or resets it to the current commit, so any
      // commits produced while detached are preserved on the feature branch. We intentionally
      // do NOT fetch/rebase here: the detached state usually means the agent restored a
      // specific sha, and we want to push exactly that state.
      const co = await SandboxService.runWithCwd(sandbox, 'git', ['checkout', '-B', featureBranch], cwd);
      if (co.exitCode !== 0) {
        throw new Error(`Failed to attach detached HEAD to ${featureBranch}: ${await co.stderr()}`);
      }
      return;
    }

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
    const safeTitle = (options.title && String(options.title).trim()) || 'requirement';

    await SandboxService.clearStuckGitOperationState(sandbox, cwd);

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
    if (SandboxService.isInvalidOriginBranchName(branch) && !options.requirementId) {
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
    if (SandboxService.isInvalidOriginBranchName(pushName)) {
      throw new Error(
        'Cannot push: invalid target branch name (empty, HEAD, or unknown). The workspace must be on a real branch for origin.',
      );
    }

    console.log(`[Sandbox] ${aheadCount} commit(s) ahead of remote on ${branch}, pushing as ${pushName}...`);
    const pushed = await SandboxService.pushWithRebaseRetry(sandbox, pushName, cwd);
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
   * Pushes and, on non-fast-forward rejection, tries `fetch + rebase + push` once.
   * Covers the common race where another sandbox (or out-of-band GitHub edit)
   * advanced `origin/<branch>` while this run was working.
   * Returns `{ ok: true, rebased }` on success; `{ ok: false, stderr }` otherwise.
   */
  private static async pushWithRebaseRetry(
    sandbox: Sandbox,
    branch: string,
    cwd: string,
  ): Promise<{ ok: true; rebased: boolean } | { ok: false; stderr: string }> {
    const b = String(branch).trim();
    if (SandboxService.isInvalidOriginBranchName(b)) {
      return {
        ok: false,
        stderr:
          'Refusing to push: target branch is empty, HEAD, or not a real branch name. Attach with `git checkout -B <branch>` or pass requirementId in commit options.',
      };
    }
    // Fully qualify the destination ref so the remote always receives refs/heads/<name>.
    // Using `git push -u origin <name>` is ambiguous for some remotes/servers when
    // the local side resolves oddly; `HEAD:refs/heads/<name>` is explicit and also
    // works when the current commit is the one to publish.
    const refspec = `HEAD:refs/heads/${b}`;
    const first = await SandboxService.runWithCwd(sandbox, 'git', ['push', '-u', 'origin', refspec], cwd);
    if (first.exitCode === 0) {
      return { ok: true, rebased: false };
    }

    const firstStderr = await first.stderr();
    const isNonFastForward = /\[rejected\]|non-fast-forward|fetch first|stale info/i.test(firstStderr);
    if (!isNonFastForward) {
      return { ok: false, stderr: firstStderr };
    }

    console.warn(`[Sandbox] push rejected (non-fast-forward) on ${b} — fetching + rebasing onto origin and retrying once`);

    const fetchRes = await SandboxService.runWithCwd(sandbox, 'git', ['fetch', 'origin', b], cwd);
    if (fetchRes.exitCode !== 0) {
      return { ok: false, stderr: `Initial push rejected and fetch origin ${b} failed: ${await fetchRes.stderr()}\n---\n${firstStderr}` };
    }

    await SandboxService.clearStuckGitOperationState(sandbox, cwd);
    const rebaseRes = await SandboxService.runWithCwd(sandbox, 'git', ['rebase', `origin/${b}`], cwd);
    if (rebaseRes.exitCode !== 0) {
      const rebaseErr = await rebaseRes.stderr();
      await SandboxService.runWithCwd(sandbox, 'git', ['rebase', '--abort'], cwd);
      await SandboxService.clearStuckGitOperationState(sandbox, cwd);
      return {
        ok: false,
        stderr: `Push rejected and automatic rebase on origin/${b} produced conflicts — manual resolution required: ${rebaseErr}\n---\n${firstStderr}`,
      };
    }

    const retry = await SandboxService.runWithCwd(sandbox, 'git', ['push', '-u', 'origin', refspec], cwd);
    if (retry.exitCode === 0) {
      return { ok: true, rebased: true };
    }
    const retryStderr = await retry.stderr();
    return { ok: false, stderr: `Push still rejected after rebase on origin/${b}: ${retryStderr}\n---\nInitial rejection: ${firstStderr}` };
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
