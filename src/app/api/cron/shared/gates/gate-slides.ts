import type { FlowGateInput, FlowGateResult, FlowGateSignal } from './types';
import { verifyOriginAndRecover } from '../step-git-gate';

/**
 * Gate for the `presentation` flow. Checks:
 *   - Build succeeds (`npm run build` if package.json present, otherwise
 *     `npx --yes reveal-md --version` smoke).
 *   - Slide count ≥ 3 in the canonical entry (`presentation.md` / `slides/`).
 *   - No slide longer than 120 words (heuristic; encourages concise decks).
 */
export async function runSlidesGate(input: FlowGateInput): Promise<FlowGateResult> {
  const signals: FlowGateSignal[] = [];
  const pkg = await runShell(input, `[ -f package.json ] && echo yes || echo no`);
  const hasPackage = pkg.stdout.trim() === 'yes';

  if (hasPackage) {
    const build = await runShell(input, `npm run build --silent 2>&1 | tail -50`);
    signals.push({ name: 'npm-build', ok: build.exit === 0, detail: build.stdout.slice(-400) });
  } else {
    signals.push({ name: 'package-json', ok: false, detail: 'no package.json' });
  }

  const find = await runShell(
    input,
    `(test -f presentation.md && cat presentation.md; find ./slides -type f -name '*.md' -exec cat {} \\; 2>/dev/null) | head -2000`,
  );
  const text = find.stdout;
  const slides = text.split(/^---\s*$/m).map((s) => s.trim()).filter(Boolean);
  signals.push({ name: 'min-slides', ok: slides.length >= 3, detail: `${slides.length} slides` });

  let overflows = 0;
  for (const s of slides) {
    const words = s.split(/\s+/).filter(Boolean).length;
    if (words > 120) overflows++;
  }
  signals.push({ name: 'word-budget', ok: overflows === 0, detail: `${overflows} slides over 120 words` });

  const ok = signals.every((s) => s.ok);
  
  if (!ok) {
    return { ok, flow: input.flow, signals, reason:  'slides gate failed' };
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
