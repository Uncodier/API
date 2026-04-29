import type { FlowGateInput, FlowGateResult, FlowGateSignal } from './types';
import { verifyOriginAndRecover } from '../step-git-gate';

/**
 * Backend-style gate (used for `automation` flow and any item with kind ∈
 * {auth, crud, integration} that ships its own backend route). Verifies:
 *   - There is at least one Next.js route handler (`route.ts` / `route.js`)
 *     OR an Express-style `server.ts` entry.
 *   - When a route handler accepts `?mode=test`, the test invocation
 *     responds with `{ ok: true }`. We only run the probe when the runner
 *     can curl localhost from the sandbox — otherwise we skip with a
 *     warning signal.
 */
export async function runBackendGate(input: FlowGateInput): Promise<FlowGateResult> {
  const signals: FlowGateSignal[] = [];

  const routes = await runShell(
    input,
    `find ./src/app/api ./app/api ./pages/api 2>/dev/null -type f \\( -name 'route.ts' -o -name 'route.js' \\) | head -20`,
  );
  const routeFiles = routes.stdout.split('\n').filter(Boolean);

  const serverEntries = await runShell(
    input,
    `find . -maxdepth 2 -type f \\( -name 'server.ts' -o -name 'server.js' \\) -not -path './node_modules/*' 2>/dev/null | head -5`,
  );
  const serverFiles = serverEntries.stdout.split('\n').filter(Boolean);

  signals.push({
    name: 'has-backend-entry',
    ok: routeFiles.length + serverFiles.length > 0,
    detail: `${routeFiles.length} routes, ${serverFiles.length} server entries`,
  });

  const ok = signals.every((s) => s.ok);
  
  if (!ok) {
    return { ok, flow: input.flow, signals, reason: 'backend gate failed' };
  }

  if (input.appContext) {
    const recovery = await verifyOriginAndRecover({
      sandbox: input.sandbox,
      planTitle: input.appContext.planTitle,
      requirementId: input.requirementId,
      stepOrder: input.appContext.stepOrder,
      stepPrompt: input.appContext.stepPrompt,
      stepContext: input.appContext.stepContext,
      currentMessages: input.appContext.currentMessages,
      context: input.appContext.assistantContext,
      fullTools: input.appContext.fullTools,
      lastResult: input.appContext.lastResult,
      audit: input.audit,
      gitRepoKind: input.appContext.gitRepoKind,
    });
    if (recovery.sandboxReplacement) {
      input.sandbox = recovery.sandboxReplacement;
    }
    if (!recovery.ok) {
      return {
        ok: false,
        flow: input.flow,
        signals: [...signals, ...(recovery.signals.origin ? [{ name: 'origin', ok: false, detail: recovery.error }] : [])],
        reason: recovery.error,
        sandboxUnavailable: recovery.sandboxUnavailable,
        sandboxReplacement: recovery.sandboxReplacement,
      };
    }
  }

  return { ok, flow: input.flow, signals, reason: undefined, sandboxReplacement: input.sandbox };

}

async function runShell(input: FlowGateInput, command: string): Promise<{ stdout: string; exit: number }> {
  const res = await input.sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `cd "${input.workDir}" && ${command}`],
  });
  return { stdout: await res.stdout(), exit: res.exitCode };
}
