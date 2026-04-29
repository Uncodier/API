import type { FlowGateInput, FlowGateResult, FlowGateSignal } from './types';
import { verifyOriginAndRecover } from '../step-git-gate';

/**
 * Gate for the `contract` flow. A contract deliverable must:
 *   - have at least one `.md` / `.mdx` file under `contracts/` or root.
 *   - resolve every `{{placeholder}}` (no `{{ ... }}` left).
 *   - end with a `## Firma` (or `## Signature`) section.
 *   - include an ISO date inside the signature block.
 */
export async function runContractGate(input: FlowGateInput): Promise<FlowGateResult> {
  const signals: FlowGateSignal[] = [];
  const list = await runShell(
    input,
    `(find ./contracts -type f \\( -name '*.md' -o -name '*.mdx' \\) 2>/dev/null; find . -maxdepth 1 -type f \\( -name 'contract*.md' -o -name 'CONTRACT*.md' \\)) | sort -u | head -20`,
  );
  const files = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  signals.push({ name: 'has-contract', ok: files.length > 0, detail: `${files.length} files` });
  if (files.length === 0) {
    return { ok: false, flow: input.flow, signals, reason: 'contract gate: no contract files found' };
  }

  let unresolved = 0;
  let missingSignature = 0;
  let missingDate = 0;
  for (const f of files) {
    const cat = await runShell(input, `cat "${f}"`);
    const text = cat.stdout;
    if (/\{\{\s*\w+\s*\}\}/.test(text)) unresolved++;
    if (!/^##\s+(Firma|Signature)\b/im.test(text)) missingSignature++;
    if (!/\b20\d{2}-\d{2}-\d{2}\b/.test(text)) missingDate++;
  }
  signals.push({ name: 'placeholders-resolved', ok: unresolved === 0, detail: `${unresolved} unresolved` });
  signals.push({ name: 'has-signature', ok: missingSignature === 0, detail: `${missingSignature} missing` });
  signals.push({ name: 'has-date', ok: missingDate === 0, detail: `${missingDate} missing` });

  const ok = signals.every((s) => s.ok);
  
  if (!ok) {
    return { ok, flow: input.flow, signals, reason:  'contract gate failed' };
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
