import type { FlowGateInput, FlowGateResult, FlowGateSignal } from './types';
import { verifyOriginAndRecover } from '../step-git-gate';

/**
 * Gate for `task` and `makinari` flows. Tasks ship artefacts: a script that
 * runs, a report markdown, a CSV/JSON dataset, etc. The gate checks that:
 *   - At least one new file under `artifacts/`, `reports/` or `outputs/`.
 *   - When a `run.sh` is present it must exit 0 from `bash -n run.sh`
 *     (syntactic check; the real run is the Consumer's responsibility).
 */
export async function runTaskGate(input: FlowGateInput): Promise<FlowGateResult> {
  const signals: FlowGateSignal[] = [];

  const list = await runShell(
    input,
    `find ./artifacts ./reports ./outputs -type f 2>/dev/null | head -20`,
  );
  const files = list.stdout.split('\n').filter(Boolean);
  signals.push({ name: 'has-artifacts', ok: files.length > 0, detail: `${files.length} files` });

  // `run.sh` is optional for task/makinari flows — only syntax-check it when
  // the file actually exists. Absent file = no signal (neither pass nor fail).
  const exists = await runShell(input, `[ -f run.sh ] && echo YES || echo NO`);
  if (exists.stdout.trim() === 'YES') {
    const syntax = await runShell(input, `bash -n run.sh && echo OK || echo FAIL`);
    const ok = syntax.stdout.trim() === 'OK';
    signals.push({ name: 'run.sh-syntax', ok, detail: ok ? 'parsed' : 'syntax error' });
  }

  const ok = signals.every((s) => s.ok);
  
  if (!ok) {
    return { ok, flow: input.flow, signals, reason: 'task gate failed' };
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
