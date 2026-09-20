/**
 * Flow-gate adapter for `app` and `site` flows. Delegates to the canonical
 * `runBuildAndOriginGate` (owns the heavy build + runtime probe + visual +
 * scenarios + Vercel deploy + origin push recovery pipeline) and projects
 * its result into the unified `FlowGateResult` shape.
 *
 * This file is intentionally thin: it exists so the dispatcher
 * (`runGateForFlow`) is the one and only entry point for gate execution
 * across every flow. All heavy logic stays in `step-git-gate.ts`.
 */
import { runBuildAndOriginGate, type GateSignals } from '../step-git-gate';
import type {
  AppRichSignals,
  FlowGateFailureKind,
  FlowGateInput,
  FlowGateResult,
  FlowGateSignal,
} from './types';

function classifyOriginFailure(
  failureKind: string | undefined,
): FlowGateFailureKind {
  if (
    failureKind === 'auth' ||
    failureKind === 'protected_branch' ||
    failureKind === 'network' ||
    failureKind === 'platform' ||
    failureKind === 'sandbox_unavailable'
  ) {
    return 'infrastructure_unavailable';
  }
  if (
    failureKind === 'pre_push_build' ||
    failureKind === 'vercel_layout' ||
    failureKind === 'server_hook'
  ) {
    return 'product_defect';
  }
  return 'missing_precondition';
}

function flattenAppSignals(rich: GateSignals): FlowGateSignal[] {
  const out: FlowGateSignal[] = [];
  if (rich.build) {
    out.push({ name: 'build', ok: !!rich.build.ok, detail: rich.build.error_tail || rich.build.layout_error });
  }
  if (rich.interaction) {
    out.push({ name: 'interaction', ok: rich.interaction.ok, detail: rich.interaction.summary });
  }
  if (rich.runtime) {
    const detail = rich.runtime.startup_error
      ? rich.runtime.startup_error
      : rich.runtime.server_errors?.length
      ? `${rich.runtime.server_errors.length} server error(s)`
      : undefined;
    out.push({ name: 'runtime', ok: !!rich.runtime.ok, detail });
  }
  if (rich.api) {
    out.push({ name: 'api', ok: !!rich.api.ok, detail: rich.api.apis ? `${rich.api.apis.length} endpoint(s) probed` : undefined });
  }
  if (rich.console) {
    const errors = (rich.console.page_errors?.length ?? 0) + (rich.console.failed_requests?.length ?? 0);
    const disposition = rich.observations?.find(
      (observation) => observation.kind === 'console',
    )?.disposition ?? (rich.console.ok ? 'pass' : 'hard_fail');
    out.push({
      name: 'console',
      ok: !!rich.console.ok || disposition === 'advisory',
      detail: errors > 0 ? `${errors} error(s)` : undefined,
      disposition,
      failureKind:
        disposition === 'hard_fail' ? 'product_defect' : undefined,
    });
  }
  if (rich.visual) {
    const disposition = rich.observations?.find(
      (observation) => observation.kind === 'visual',
    )?.disposition ??
      (rich.visual.ok && rich.visual.pass ? 'pass' : 'hard_fail');
    out.push({
      name: 'visual',
      ok:
        (!!rich.visual.ok && !!rich.visual.pass) ||
        disposition === 'advisory',
      detail: rich.visual.summary,
      disposition,
      failureKind:
        disposition === 'hard_fail' ? 'product_defect' : undefined,
    });
  }
  if (rich.scenarios) {
    out.push({ name: 'scenarios', ok: !!rich.scenarios.ok, detail: rich.scenarios.scenarios ? `${rich.scenarios.scenarios.length} scenario(s)` : undefined });
  }
  if (rich.tests) {
    out.push({
      name: 'tests',
      ok: rich.tests.ok,
      detail: rich.tests.tests.map((test) => test.command).join(', '),
      disposition: rich.tests.ok ? 'pass' : 'hard_fail',
    });
  }
  if (rich.origin) {
    const detail = rich.origin.ok
      ? rich.origin.branch
      : rich.origin.errorForAgent || rich.origin.error;
    const failureKind = rich.origin.ok
      ? undefined
      : classifyOriginFailure(rich.origin.failureKind);
    out.push({
      name: 'origin',
      ok: !!rich.origin.ok,
      detail,
      disposition: rich.origin.ok
        ? 'pass'
        : failureKind === 'product_defect'
          ? 'hard_fail'
          : 'unknown',
      failureKind,
    });
  }
  if (rich.deploy) {
    const state = rich.deploy.deployState ?? 'unknown';
    const ok = state === 'success' || state === 'skipped_default_branch';
    out.push({ name: 'deploy', ok, detail: rich.deploy.detail ? `${state} — ${rich.deploy.detail}` : state });
  }
  for (const observation of rich.observations || []) {
    out.push({
      name: `observation:${observation.kind}`,
      ok: observation.disposition !== 'hard_fail',
      detail: `${observation.target ? `${observation.target}: ` : ''}${observation.detail}`,
      disposition: observation.disposition,
    });
  }
  return out;
}

export async function runAppGate(input: FlowGateInput): Promise<FlowGateResult> {
  if (!input.appContext) {
    return {
      ok: false,
      failureKind: 'contract_error',
      flow: input.flow,
      signals: [],
      error: 'runAppGate: missing appContext (executor must pass planTitle/stepOrder/stepPrompt/... for app flows)',
    };
  }
  const ac = input.appContext;
  const gate = await runBuildAndOriginGate({
    sandbox: input.sandbox,
    planTitle: ac.planTitle,
    requirementId: input.requirementId,
    stepOrder: ac.stepOrder,
    backlogItemId: ac.backlogItemId,
    interactionBaselineSha: ac.interactionBaselineSha,
    stepPrompt: ac.stepPrompt,
    stepContext: ac.stepContext,
    currentMessages: ac.currentMessages,
    context: ac.assistantContext,
    fullTools: ac.fullTools,
    lastResult: ac.lastResult,
    audit: input.audit,
    gitRepoKind: ac.gitRepoKind,
  });

  const richSignals: AppRichSignals = gate.signals;
  const signals = flattenAppSignals(richSignals);
  const remediationScheduled =
    richSignals.interaction?.active_item_suspended === true;
  const originFailureKind = richSignals.origin?.ok === false
    ? classifyOriginFailure(richSignals.origin.failureKind)
    : undefined;
  const infrastructureFailure = Boolean(
    gate.infrastructureFailure ||
    gate.sandboxUnavailable ||
    originFailureKind === 'infrastructure_unavailable',
  );

  return {
    ok: gate.ok,
    disposition: gate.ok
      ? 'pass'
      : infrastructureFailure
        ? 'unknown'
        : remediationScheduled
          ? 'advisory'
          : 'hard_fail',
    failureKind: gate.ok || remediationScheduled
      ? undefined
      : originFailureKind ||
        (infrastructureFailure
          ? 'infrastructure_unavailable'
          : 'product_defect'),
    flow: input.flow,
    signals,
    error: gate.error,
    richSignals,
    lastResult: gate.lastResult,
    vercelDeploy: gate.vercelDeploy,
    infrastructureFailure,
    sandboxUnavailable: gate.sandboxUnavailable,
    sandboxReplacement: gate.sandboxReplacement,
    remediationScheduled,
    skipAttemptBump: remediationScheduled,
  };
}
