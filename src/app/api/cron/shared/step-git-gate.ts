/**
 * Plan-step completion gate: npm run build + verified push to origin (cron sandbox only).
 * Prompts live in step-git-prompts.ts (no heavy imports) for workflow bundles.
 */

import type { Sandbox } from '@vercel/sandbox';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import type { AssistantContext } from '@/app/api/robots/instance/assistant/steps';
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  commitWorkspaceToOrigin,
  repoNameForGitRepoKind,
  syncLatestRequirementStatusWithPreview,
  type GitRepoKind,
} from './cron-commit-helpers';
import {
  fetchGitHubBranchTipSha,
  pollGitHubDeploymentForSha,
} from '@/lib/services/github-deployment-status';
import { MAX_PUSH_RECOVERY_TURNS } from './step-git-prompts';
import { validateNpmRepoForVercelDeploy } from './vercel-npm-repo-guard';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { fetchAndLogVercelBuildLog } from '@/lib/services/vercel-build-logs';

export { MAX_PUSH_RECOVERY_TURNS } from './step-git-prompts';

const VERCEL_LOG_AGENT_MAX = 6000;

function buildPushRecoveryAppend(requirementId: string, expectedBranch: string): string {
  const wd = SandboxService.WORK_DIR;
  return `

*** PUSH RECOVERY (mandatory until origin is updated) ***
The automated commit/push did NOT complete successfully, or the platform could not verify your work on GitHub.
Prefer sandbox_push_checkpoint (title_hint = current step title) if the tool is available; use sandbox_restore_checkpoint (action=list) to list commits and action=restore to rewind the sandbox working tree only; otherwise use sandbox_run_command with cwd ${wd} (e.g. cd ${wd} && ...).

1) Inspect: git status -sb && git branch -v && git remote -v
2) Work on a feature branch, NOT main/master. Expected branch name for this requirement: "${expectedBranch}"
   - If you are on main/master: git fetch origin && git checkout -b "${expectedBranch}" OR git checkout "${expectedBranch}" if it already exists locally/remotely.
3) Stage and commit: git add -A && git commit -m "chore: sync step work"  (if nothing to commit, skip commit)
4) Push: git push -u origin HEAD
The usual rule against manual git commit/push is SUSPENDED until git push succeeds. Read stderr if push fails (permissions, branch, etc.).
5) Confirm: git status should be clean and your branch should track origin.

Reply briefly when push succeeded or paste the error from git.`;
}

async function persistOrVerifyOrigin(
  sandbox: Sandbox,
  planTitle: string,
  requirementId: string,
  label: string,
  audit?: CronAuditContext,
  gitRepoKind?: GitRepoKind,
): Promise<{ ok: boolean; branch: string; error?: string }> {
  try {
    const r = await commitWorkspaceToOrigin(sandbox, planTitle, requirementId, label, audit, {
      gitRepoKind,
    });
    return { ok: r.pushed, branch: r.branch };
  } catch (e: any) {
    return { ok: false, branch: '', error: e?.message || String(e) };
  }
}

export async function validateBuildForStep(sandbox: Sandbox): Promise<string | null> {
  const wd = SandboxService.WORK_DIR;
  const buildRes = await sandbox.runCommand('sh', ['-c', `cd ${wd} && npm run build`]);
  if (buildRes.exitCode !== 0) {
    const stderr = await buildRes.stderr();
    return `Build failed: ${stderr.substring(0, 500)}`;
  }
  return null;
}

export type OriginGateParams = {
  sandbox: Sandbox;
  planTitle: string;
  requirementId: string;
  stepOrder: number;
  stepPrompt: string;
  currentMessages: any[];
  context: AssistantContext;
  fullTools: any[];
  lastResult: any;
  /** Cron audit — logs deterministic gate outcomes to instance_logs */
  audit?: CronAuditContext;
  /** Matches sandbox tool context / cron workflow (apps vs automations repo). */
  gitRepoKind?: GitRepoKind;
};

/**
 * After main agent loop: npm run build, then verify origin (persist + optional recovery turns).
 */
export type VercelDeployGateInfo = {
  previewUrl: string | null;
  deployState: string;
  detail?: string;
  /** When VERCEL_TOKEN + project id are set — excerpt stored in instance_logs and on gate errors */
  buildLogExcerpt?: string | null;
};

export async function runBuildAndOriginGate(params: OriginGateParams): Promise<{
  ok: boolean;
  lastResult: any;
  error?: string;
  vercelDeploy?: VercelDeployGateInfo;
}> {
  const {
    sandbox,
    planTitle,
    requirementId,
    stepOrder,
    stepPrompt,
    currentMessages,
    context,
    fullTools,
    lastResult: initialLastResult,
    audit,
    gitRepoKind = 'applications',
  } = params;

  let lastResult = initialLastResult;

  const vercelLayoutErr = await validateNpmRepoForVercelDeploy(sandbox, gitRepoKind);
  if (vercelLayoutErr) {
    const msg = `Vercel/npm layout: ${vercelLayoutErr}`;
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_BUILD,
      level: 'error',
      message: `Step ${stepOrder} gate: ${msg.slice(0, 500)}`,
      details: { stepOrder, error: msg.slice(0, 1200) },
    });
    return { ok: false, lastResult, error: msg };
  }

  const buildError = await validateBuildForStep(sandbox);
  if (buildError) {
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_BUILD,
      level: 'error',
      message: `Step ${stepOrder} gate: npm run build failed`,
      details: { stepOrder, error: buildError.slice(0, 1200) },
    });
    return { ok: false, lastResult, error: buildError };
  }

  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.GATE_BUILD,
    message: `Step ${stepOrder} gate: npm run build passed`,
    details: { stepOrder },
  });

  if (!requirementId) {
    console.warn(`[StepGitGate] No requirement_id — skipping origin verification for step ${stepOrder}`);
    return { ok: true, lastResult };
  }

  let persist = await persistOrVerifyOrigin(
    sandbox,
    planTitle,
    requirementId,
    `Cron step ${stepOrder} pre-close (${requirementId})`,
    audit,
    gitRepoKind,
  );

  if (!persist.ok) {
    console.warn(
      `[StepGitGate] Origin not verified (${persist.error || 'not pushed'}). Starting push recovery (${MAX_PUSH_RECOVERY_TURNS} turns).`,
    );
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_ORIGIN,
      level: 'warn',
      message: `Step ${stepOrder} gate: origin not verified before recovery (${persist.error || 'not pushed'})`.slice(
        0,
        500,
      ),
      details: { stepOrder, error: persist.error?.slice?.(0, 800) },
    });
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_PUSH_RECOVERY,
      message: `Step ${stepOrder}: starting push recovery (max ${MAX_PUSH_RECOVERY_TURNS} agent turns)`,
      details: { stepOrder, maxTurns: MAX_PUSH_RECOVERY_TURNS },
    });
    const expectedBranch = SandboxService.buildBranchName(requirementId, planTitle);
    const recoverySystem = stepPrompt + buildPushRecoveryAppend(requirementId, expectedBranch);
    const recoveryUser = {
      role: 'user' as const,
      content:
        'REACTIVE TASK: Your work is not confirmed on the remote yet. Follow PUSH RECOVERY: confirm the code is correct, then commit and push so the team can see it.',
    };
    let recoveryMessages = [...currentMessages, recoveryUser];

    for (let t = 0; t < MAX_PUSH_RECOVERY_TURNS; t++) {
      console.log(`[StepGitGate] Push recovery turn ${t + 1}/${MAX_PUSH_RECOVERY_TURNS}`);
      lastResult = await executeAssistantStep(recoveryMessages, context.instance, {
        ...context.executionOptions,
        system_prompt: recoverySystem,
        custom_tools: fullTools,
      });
      recoveryMessages = lastResult.messages;
      persist = await persistOrVerifyOrigin(
        sandbox,
        planTitle,
        requirementId,
        `Cron step ${stepOrder} recovery ${t + 1} (${requirementId})`,
        audit,
        gitRepoKind,
      );
      if (persist.ok) break;
    }
  }

  if (!persist.ok) {
    const errFinal = `Origin push not verified after recovery: ${persist.error || 'branch not synced'}`;
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_ORIGIN,
      level: 'error',
      message: `Step ${stepOrder} gate: ${errFinal}`.slice(0, 500),
      details: { stepOrder, error: errFinal.slice(0, 1200) },
    });
    return {
      ok: false,
      lastResult,
      error: errFinal,
    };
  }

  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.GATE_ORIGIN,
    message: `Step ${stepOrder} gate: origin verified (branch ${persist.branch})`,
    details: { stepOrder, branch: persist.branch },
  });

  const branch = persist.branch;
  if (!branch || branch === 'main' || branch === 'master') {
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_VERCEL_DEPLOY,
      message: `Step ${stepOrder} gate: deploy check skipped (default branch)`,
      details: { stepOrder, branch },
    });
    return {
      ok: true,
      lastResult,
      vercelDeploy: { previewUrl: null, deployState: 'skipped_default_branch', detail: branch },
    };
  }

  const gitOrg = process.env.GIT_ORG || 'makinary';
  const repoName = repoNameForGitRepoKind(gitRepoKind);
  const sha = await fetchGitHubBranchTipSha(gitOrg, repoName, branch);
  if (!sha) {
    const errSha = `Deploy gate: could not resolve GitHub SHA for branch ${branch}`;
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_VERCEL_DEPLOY,
      level: 'error',
      message: `Step ${stepOrder} gate: ${errSha}`,
      details: { stepOrder, branch },
    });
    return { ok: false, lastResult, error: errSha };
  }

  const poll = await pollGitHubDeploymentForSha(gitOrg, repoName, sha, {
    maxAttempts: 24,
    pollIntervalMs: 5000,
  });

  const vercelLogOutcome: 'success' | 'failure' | 'timeout' =
    poll.state === 'success' ? 'success' : poll.state === 'pending' ? 'timeout' : 'failure';

  let vercelBuildExcerpt: string | null = null;
  try {
    vercelBuildExcerpt = await fetchAndLogVercelBuildLog(audit, {
      sha,
      branch,
      stepOrder,
      gitRepoKind,
      outcome: vercelLogOutcome,
    });
  } catch (e: unknown) {
    console.warn('[StepGitGate] Vercel build log fetch failed:', e instanceof Error ? e.message : e);
  }

  const appendVercelLogToAgentError = (msg: string) =>
    vercelBuildExcerpt?.trim()
      ? `${msg}\n\n--- Vercel build log (API excerpt) ---\n${vercelBuildExcerpt.slice(0, VERCEL_LOG_AGENT_MAX)}`
      : msg;

  if (poll.state === 'success' && poll.previewUrl) {
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_VERCEL_DEPLOY,
      message: `Step ${stepOrder} gate: GitHub deployment success (preview URL)`,
      details: {
        stepOrder,
        branch,
        sha: sha.slice(0, 12),
        previewUrl: poll.previewUrl,
      },
    });
    if (audit?.siteId) {
      try {
        await syncLatestRequirementStatusWithPreview({
          requirementId,
          branch,
          siteId: audit.siteId,
          instanceId: audit.instanceId,
          gitRepoKind,
          preview_url_resolved: poll.previewUrl,
          use_resolved_preview_only: true,
        });
      } catch (e: unknown) {
        console.warn('[StepGitGate] preview sync after deploy gate:', e instanceof Error ? e.message : e);
      }
    }
    return {
      ok: true,
      lastResult,
      vercelDeploy: {
        previewUrl: poll.previewUrl,
        deployState: 'success',
        buildLogExcerpt: vercelBuildExcerpt,
      },
    };
  }

  if (poll.state === 'failure' || poll.state === 'error') {
    const err = appendVercelLogToAgentError(
      `Deploy gate: GitHub reported deployment ${poll.state}${poll.detail ? ` — ${poll.detail}` : ''}`,
    );
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_VERCEL_DEPLOY,
      level: 'error',
      message: `Step ${stepOrder} gate: ${err.slice(0, 500)}`,
      details: { stepOrder, branch, sha: sha.slice(0, 12), state: poll.state },
    });
    return {
      ok: false,
      lastResult,
      error: err,
      vercelDeploy: {
        previewUrl: poll.previewUrl,
        deployState: poll.state,
        detail: poll.detail,
        buildLogExcerpt: vercelBuildExcerpt,
      },
    };
  }

  const errTimeout = appendVercelLogToAgentError(
    `Deploy gate: no successful GitHub deployment in time${poll.detail ? ` — ${poll.detail}` : ''}`,
  );
  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.GATE_VERCEL_DEPLOY,
    level: 'error',
    message: `Step ${stepOrder} gate: ${errTimeout.slice(0, 500)}`,
    details: { stepOrder, branch, sha: sha.slice(0, 12), state: poll.state },
  });
  return {
    ok: false,
    lastResult,
    error: errTimeout,
    vercelDeploy: {
      previewUrl: null,
      deployState: poll.state,
      detail: poll.detail,
      buildLogExcerpt: vercelBuildExcerpt,
    },
  };
}
