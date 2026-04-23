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
import type { FlowGateInput, FlowGateResult, FlowGateSignal, AppRichSignals } from './types';

function flattenAppSignals(rich: GateSignals): FlowGateSignal[] {
  const out: FlowGateSignal[] = [];
  if (rich.build) {
    out.push({ name: 'build', ok: !!rich.build.ok, detail: rich.build.error_tail || rich.build.layout_error });
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
    out.push({ name: 'console', ok: !!rich.console.ok, detail: errors > 0 ? `${errors} error(s)` : undefined });
  }
  if (rich.visual) {
    out.push({ name: 'visual', ok: !!rich.visual.ok, detail: rich.visual.summary });
  }
  if (rich.scenarios) {
    out.push({ name: 'scenarios', ok: !!rich.scenarios.ok, detail: rich.scenarios.scenarios ? `${rich.scenarios.scenarios.length} scenario(s)` : undefined });
  }
  if (rich.origin) {
    const detail = rich.origin.ok
      ? rich.origin.branch
      : rich.origin.errorForAgent || rich.origin.error;
    out.push({ name: 'origin', ok: !!rich.origin.ok, detail });
  }
  if (rich.deploy) {
    const state = rich.deploy.deployState ?? 'unknown';
    const ok = state === 'success' || state === 'skipped_default_branch';
    out.push({ name: 'deploy', ok, detail: rich.deploy.detail ? `${state} — ${rich.deploy.detail}` : state });
  }
  return out;
}

export async function runAppGate(input: FlowGateInput): Promise<FlowGateResult> {
  if (!input.appContext) {
    return {
      ok: false,
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

  return {
    ok: gate.ok,
    flow: input.flow,
    signals,
    error: gate.error,
    richSignals,
    lastResult: gate.lastResult,
    vercelDeploy: gate.vercelDeploy,
  };
}
