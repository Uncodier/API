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
  resolveGitBindingForRequirement,
  syncLatestRequirementStatusWithPreview,
  type GitRepoKind,
} from './cron-commit-helpers';
import { buildRequirementBranchName } from '@/lib/services/requirement-branch';
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
import {
  isCommitPushTriageError,
  triageGitPushError,
  type GitPushFailureKind,
} from '@/lib/services/git-push-error-triage';
import { isSandboxGoneError } from '@/lib/services/sandbox-gone-error';
import { fetchAndLogVercelBuildLog } from '@/lib/services/vercel-build-logs';
import { runRuntimeAndVisualProbes } from './step-gate-probes';
import type {
  ApiSignal,
  BuildSignal,
  ConsoleSignal,
  DeploySignal,
  OriginSignal,
  RuntimeSignal,
  ScenarioSignal,
  VisualSignal,
} from './step-iteration-signals';

export { MAX_PUSH_RECOVERY_TURNS } from './step-git-prompts';
export { runGateForFlow } from './gates';
export type { FlowGateInput, FlowGateResult, FlowGateSignal } from './gates';

const VERCEL_LOG_AGENT_MAX = 6000;

function buildPushRecoveryAppend(requirementId: string, expectedBranch: string): string {
  const wd = SandboxService.WORK_DIR;
  return `

*** PUSH RECOVERY (mandatory until origin is updated) ***
The automated commit/push did NOT complete successfully, or the platform could not verify your work on GitHub.
Prefer sandbox_push_checkpoint (title_hint = current step title) if the tool is available; use sandbox_restore_checkpoint (action=list) to list commits and action=restore to rewind the sandbox working tree only; otherwise use sandbox_run_command with cwd ${wd} (e.g. cd ${wd} && ...).

1) Inspect: git status -sb && git branch -v && git remote -v && git symbolic-ref -q HEAD || echo DETACHED
2) Work on a feature branch, NOT main/master, and NOT detached HEAD. Expected branch name for this requirement: "${expectedBranch}"
   - If you are on main/master: git fetch origin && git checkout -b "${expectedBranch}" OR git checkout "${expectedBranch}" if it already exists locally/remotely.
   - If HEAD is detached (git symbolic-ref failed above): git checkout -B "${expectedBranch}"   # preserves commits made while detached.
3) Stage and commit: git add -A && git commit -m "chore: sync step work"  (if nothing to commit, skip commit)
4) Push the named branch (NOT 'HEAD'): git push -u origin "${expectedBranch}"
The usual rule against manual git commit/push is SUSPENDED until git push succeeds. Read stderr if push fails (permissions, branch, etc.).
5) Confirm: git status should be clean and your branch should track origin.

Reply briefly when push succeeded or paste the error from git.`;
}

type PersistOriginResult = {
  ok: boolean;
  branch: string;
  error?: string;
  errorForAgent?: string;
  failureKind?: GitPushFailureKind;
  agentActionable?: boolean;
  /** MicroVM stopped — reprovision, do not burn gate retries on push recovery. */
  sandboxUnavailable?: boolean;
};

async function persistOrVerifyOrigin(
  sandbox: Sandbox,
  planTitle: string,
  requirementId: string,
  label: string,
  audit?: CronAuditContext,
  gitRepoKind?: GitRepoKind,
): Promise<PersistOriginResult & { sandbox?: Sandbox }> {
  try {
    const r = await commitWorkspaceToOrigin(sandbox, planTitle, requirementId, label, audit, {
      gitRepoKind,
    });
    return {
      ok: r.pushed,
      branch: r.branch,
      ...(r.sandboxReplacement ? { sandbox: r.sandboxReplacement } : {}),
    };
  } catch (e: unknown) {
    if (isCommitPushTriageError(e)) {
      const t = e.triage;
      return {
        ok: false,
        branch: '',
        error: t.operatorMessage,
        errorForAgent: t.agentMessage,
        failureKind: t.failureKind,
        agentActionable: t.agentActionable,
        sandboxUnavailable: t.failureKind === 'sandbox_unavailable',
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    const tri = triageGitPushError(msg);
    return {
      ok: false,
      branch: '',
      error: tri.operatorMessage,
      errorForAgent: tri.agentMessage,
      failureKind: tri.failureKind,
      agentActionable: tri.agentActionable,
      sandboxUnavailable: tri.failureKind === 'sandbox_unavailable',
    };
  }
}

/** Tail size for sandbox `npm run build` output (combined stdout+stderr) sent to the agent on retry. */
const SANDBOX_BUILD_OUTPUT_MAX = 6000;

export async function validateBuildForStep(sandbox: Sandbox): Promise<string | null> {
  const wd = SandboxService.WORK_DIR;
  // Merge stdout+stderr so the agent sees Next.js compile errors (most go to stdout)
  // alongside any stderr noise. Keep the TAIL — Next.js prints the actionable error last.
  const buildRes = await sandbox.runCommand('sh', ['-c', `cd ${wd} && npm run build 2>&1`]);
  if (buildRes.exitCode !== 0) {
    const stdout = await buildRes.stdout().catch(() => '');
    const stderr = await buildRes.stderr().catch(() => '');
    const combined = (stdout || '') + (stderr ? `\n${stderr}` : '');
    const tail =
      combined.length > SANDBOX_BUILD_OUTPUT_MAX
        ? `…(truncated ${combined.length - SANDBOX_BUILD_OUTPUT_MAX} earlier chars)\n${combined.slice(-SANDBOX_BUILD_OUTPUT_MAX)}`
        : combined;
    return `Build failed (npm run build, exit ${buildRes.exitCode}):\n${tail}`;
  }
  return null;
}

export type OriginGateParams = {
  sandbox: Sandbox;
  planTitle: string;
  requirementId: string;
  stepOrder: number;
  stepPrompt: string;
  /** Plan step context used to ground visual-critic + iteration signals. */
  stepContext?: {
    title?: string;
    instructions?: string;
    expected_output?: string;
    brand_context?: string;
  };
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

export type GateSignals = {
  build?: BuildSignal;
  runtime?: RuntimeSignal;
  api?: ApiSignal;
  console?: ConsoleSignal;
  visual?: VisualSignal;
  scenarios?: ScenarioSignal;
  origin?: OriginSignal;
  deploy?: DeploySignal;
};

export async function runBuildAndOriginGate(params: OriginGateParams): Promise<{
  ok: boolean;
  lastResult: any;
  error?: string;
  vercelDeploy?: VercelDeployGateInfo;
  signals: GateSignals;
  sandboxUnavailable?: boolean;
}> {
  const {
    sandbox: initialSandbox,
    planTitle,
    requirementId,
    stepOrder,
    stepPrompt,
    stepContext,
    currentMessages,
    context,
    fullTools,
    lastResult: initialLastResult,
    audit,
    gitRepoKind = 'applications',
  } = params;

  let sandbox = initialSandbox;
  let lastResult = initialLastResult;
  const signals: GateSignals = {};

  const vercelLayoutErr = await validateNpmRepoForVercelDeploy(sandbox, gitRepoKind);
  if (vercelLayoutErr) {
    const msg = `Vercel/npm layout: ${vercelLayoutErr}`;
    signals.build = { ok: false, layout_error: vercelLayoutErr };
    const gone = isSandboxGoneError(msg);
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_BUILD,
      level: gone ? 'warn' : 'error',
      message: `Step ${stepOrder} gate: ${msg.slice(0, 500)}`,
      details: { stepOrder, error: msg.slice(0, 1200), sandbox_unavailable: gone },
    });
    return { ok: false, lastResult, error: msg, signals, ...(gone ? { sandboxUnavailable: true } : {}) };
  }

  const buildError = await validateBuildForStep(sandbox);
  if (buildError) {
    signals.build = { ok: false, error_tail: buildError };
    const gone = isSandboxGoneError(buildError);
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_BUILD,
      level: gone ? 'warn' : 'error',
      message: `Step ${stepOrder} gate: npm run build failed`,
      details: { stepOrder, error: buildError.slice(0, 1200), sandbox_unavailable: gone },
    });
    return {
      ok: false,
      lastResult,
      error: buildError,
      signals,
      ...(gone ? { sandboxUnavailable: true } : {}),
    };
  }

  signals.build = { ok: true };
  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.GATE_BUILD,
    message: `Step ${stepOrder} gate: npm run build passed`,
    details: { stepOrder },
  });

  // Runtime probe: starts `next start` inside the sandbox, hits changed pages
  // + API routes, captures server stdout/stderr. When there are pages + we're
  // on an apps-style repo, leave the server alive so the visual probe can
  // reuse it before we kill it.
  const runtimeOutcome = await runRuntimeAndVisualProbes({
    sandbox,
    stepOrder,
    requirementId,
    gitRepoKind,
    audit,
    stepContext,
  });
  if (runtimeOutcome.signals.runtime) signals.runtime = runtimeOutcome.signals.runtime;
  if (runtimeOutcome.signals.api) signals.api = runtimeOutcome.signals.api;
  if (runtimeOutcome.signals.console) signals.console = runtimeOutcome.signals.console;
  if (runtimeOutcome.signals.visual) signals.visual = runtimeOutcome.signals.visual;
  if (runtimeOutcome.signals.scenarios) signals.scenarios = runtimeOutcome.signals.scenarios;
  if (!runtimeOutcome.ok) {
    const gone = isSandboxGoneError(runtimeOutcome.error);
    if (gone) {
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.RUNTIME_PROBE,
        level: 'warn',
        message: `Step ${stepOrder} gate: runtime probe failed — sandbox unavailable (will reprovision)`,
        details: { stepOrder, error: runtimeOutcome.error?.slice(0, 800), sandbox_unavailable: true },
      });
    }
    return {
      ok: false,
      lastResult,
      error: runtimeOutcome.error,
      signals,
      ...(gone ? { sandboxUnavailable: true } : {}),
    };
  }

  if (!requirementId) {
    console.warn(`[StepGitGate] No requirement_id — skipping origin verification for step ${stepOrder}`);
    return { ok: true, lastResult, signals };
  }

  let didPushRecovery = false;
  let persist = await persistOrVerifyOrigin(
    sandbox,
    planTitle,
    requirementId,
    `Cron step ${stepOrder} pre-close (${requirementId})`,
    audit,
    gitRepoKind,
  );
  if (persist.sandbox) sandbox = persist.sandbox;

  if (!persist.ok) {
    if (persist.sandboxUnavailable) {
      const agentLine = persist.errorForAgent || persist.error || 'Sandbox microVM unavailable';
      signals.origin = {
        ok: false,
        error: persist.error,
        errorForAgent: persist.errorForAgent,
        failureKind: persist.failureKind,
        agentActionable: false,
      };
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.GATE_ORIGIN,
        level: 'warn',
        message: `Step ${stepOrder} gate: sandbox unavailable during origin check — ${agentLine}`.slice(0, 500),
        details: {
          stepOrder,
          error: persist.error?.slice(0, 1200),
          failureKind: persist.failureKind,
          sandbox_unavailable: true,
        },
      });
      return {
        ok: false,
        lastResult,
        error: agentLine,
        signals,
        sandboxUnavailable: true,
      };
    }
    const canRecover = persist.agentActionable !== false;
    if (canRecover) {
      didPushRecovery = true;
      console.warn(
        `[StepGitGate] Origin not verified (${persist.errorForAgent || persist.error || 'not pushed'}). Starting push recovery (${MAX_PUSH_RECOVERY_TURNS} turns).`,
      );
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.GATE_ORIGIN,
        level: 'warn',
        message: `Step ${stepOrder} gate: origin not verified before recovery (${
          persist.errorForAgent || persist.error || 'not pushed'
        })`.slice(0, 500),
        details: { stepOrder, error: persist.error?.slice?.(0, 800), failureKind: persist.failureKind },
      });
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.GATE_PUSH_RECOVERY,
        message: `Step ${stepOrder}: starting push recovery (max ${MAX_PUSH_RECOVERY_TURNS} agent turns)`,
        details: { stepOrder, maxTurns: MAX_PUSH_RECOVERY_TURNS },
      });
      // The expected branch for recovery is derived solely from the requirement
      // UUID; the title becomes an optional cosmetic suffix. This matches what
      // createRequirementSandbox will emit when creating a fresh branch.
      const expectedBranch = buildRequirementBranchName(requirementId, planTitle);
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
        if (persist.sandbox) sandbox = persist.sandbox;
        if (persist.ok) break;
        if (persist.sandboxUnavailable) break;
      }
    } else {
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.GATE_ORIGIN,
        level: 'warn',
        message: `Step ${stepOrder} gate: origin not verified; push recovery skipped (not agent-actionable)`,
        details: {
          stepOrder,
          error: persist.error?.slice?.(0, 800),
          failureKind: persist.failureKind,
        },
      });
    }
  }

  if (!persist.ok) {
    if (persist.sandboxUnavailable) {
      const agentLine = persist.errorForAgent || persist.error || 'Sandbox microVM unavailable';
      signals.origin = {
        ok: false,
        error: persist.error,
        errorForAgent: persist.errorForAgent,
        failureKind: persist.failureKind,
        agentActionable: false,
      };
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.GATE_ORIGIN,
        level: 'warn',
        message: `Step ${stepOrder} gate: sandbox unavailable after recovery attempts — ${agentLine}`.slice(0, 500),
        details: {
          stepOrder,
          error: persist.error?.slice(0, 1200),
          failureKind: persist.failureKind,
          sandbox_unavailable: true,
        },
      });
      return {
        ok: false,
        lastResult,
        error: agentLine,
        signals,
        sandboxUnavailable: true,
      };
    }
    const agentLine = persist.errorForAgent || persist.error || 'branch not synced';
    const errFinal = `Origin push not verified${didPushRecovery ? ' after recovery' : ''}: ${agentLine}`;
    signals.origin = {
      ok: false,
      error: persist.error,
      errorForAgent: persist.errorForAgent,
      failureKind: persist.failureKind,
      agentActionable: persist.agentActionable,
    };
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_ORIGIN,
      level: 'error',
      message: `Step ${stepOrder} gate: ${errFinal}`.slice(0, 500),
      details: {
        stepOrder,
        error: persist.error?.slice(0, 1200),
        errorForAgent: persist.errorForAgent,
        failureKind: persist.failureKind,
      },
    });
    return {
      ok: false,
      lastResult,
      error: errFinal,
      signals,
    };
  }

  signals.origin = { ok: true, branch: persist.branch };
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
    const deploy: DeploySignal = { previewUrl: null, deployState: 'skipped_default_branch', detail: branch };
    signals.deploy = deploy;
    return {
      ok: true,
      lastResult,
      vercelDeploy: { previewUrl: null, deployState: 'skipped_default_branch', detail: branch },
      signals,
    };
  }

  const binding = await resolveGitBindingForRequirement(requirementId, gitRepoKind);
  const gitOrg = binding.org;
  const repoName = binding.repo;
  const sha = await fetchGitHubBranchTipSha(gitOrg, repoName, branch);
  if (!sha) {
    const errSha = `Deploy gate: could not resolve GitHub SHA for branch ${branch}`;
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GATE_VERCEL_DEPLOY,
      level: 'error',
      message: `Step ${stepOrder} gate: ${errSha}`,
      details: { stepOrder, branch },
    });
    return { ok: false, lastResult, error: errSha, signals };
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
      // Prefer the dpl_* parsed from the GitHub deployment status — this avoids the
      // SHA→deployment lookup that silently returns null when VERCEL_PROJECT_ID
      // is missing or points to a different Vercel project than the one that built.
      deploymentUid: poll.vercelDeploymentId ?? null,
    });
  } catch (e: unknown) {
    console.warn('[StepGitGate] Vercel build log fetch failed:', e instanceof Error ? e.message : e);
  }

  // Keep the TAIL of the excerpt: build errors are at the END of the log. The previous
  // slice(0, N) was dropping exactly the lines the agent needs to fix the issue.
  const appendVercelLogToAgentError = (msg: string) =>
    vercelBuildExcerpt?.trim()
      ? `${msg}\n\n--- Vercel build log (API excerpt, tail) ---\n${vercelBuildExcerpt.slice(-VERCEL_LOG_AGENT_MAX)}`
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
    signals.deploy = {
      previewUrl: poll.previewUrl,
      deployState: 'success',
      buildLogExcerpt: vercelBuildExcerpt,
    };
    return {
      ok: true,
      lastResult,
      vercelDeploy: {
        previewUrl: poll.previewUrl,
        deployState: 'success',
        buildLogExcerpt: vercelBuildExcerpt,
      },
      signals,
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
    signals.deploy = {
      previewUrl: poll.previewUrl,
      deployState: poll.state,
      detail: poll.detail,
      buildLogExcerpt: vercelBuildExcerpt,
    };
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
      signals,
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
  signals.deploy = {
    previewUrl: null,
    deployState: poll.state,
    detail: poll.detail,
    buildLogExcerpt: vercelBuildExcerpt,
  };
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
    signals,
  };
}
