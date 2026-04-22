import type { FlowGateInput, FlowGateResult, FlowGateSignal } from './types';

/**
 * Lightweight gate for `doc` flow. Validates:
 *   - At least one `.md` (or `.mdx`) file exists in the workspace.
 *   - Front-matter is parseable when present.
 *   - No broken `[](url)` links with empty url.
 *   - Heading hierarchy never jumps from h1 to h3+ without an h2.
 *
 * No external network calls — broken-link probe is done by the runtime
 * gate of the host site (when the doc is shipped). For pure docs we keep
 * the gate fast and deterministic.
 */
export async function runDocGate(input: FlowGateInput): Promise<FlowGateResult> {
  const signals: FlowGateSignal[] = [];

  const list = await runShell(input, `find . -type f \\( -name '*.md' -o -name '*.mdx' \\) -not -path './node_modules/*' -not -path './.next/*' | head -50`);
  const files = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  signals.push({ name: 'has-markdown', ok: files.length > 0, detail: `${files.length} files` });

  if (files.length === 0) {
    return { ok: false, flow: input.flow, signals, reason: 'doc gate: no markdown files found' };
  }

  let issues = 0;
  for (const f of files.slice(0, 20)) {
    const cat = await runShell(input, `cat "${f}"`);
    const text = cat.stdout;
    if (text.startsWith('---')) {
      const fmEnd = text.indexOf('\n---', 3);
      if (fmEnd === -1) issues++;
    }
    if (/\[[^\]]+\]\(\s*\)/.test(text)) issues++;
    const hLines = text.split('\n').filter((l) => /^#{1,6}\s/.test(l));
    let prev = 0;
    for (const h of hLines) {
      const level = (h.match(/^#+/) ?? [''])[0].length;
      if (prev > 0 && level > prev + 1) issues++;
      prev = level;
    }
  }
  signals.push({ name: 'structure-issues', ok: issues === 0, detail: `${issues} issues` });

  const ok = signals.every((s) => s.ok);
  return {
    ok,
    flow: input.flow,
    signals,
    reason: ok ? undefined : `doc gate failed (${issues} structural issues)`,
  };
}

async function runShell(input: FlowGateInput, command: string): Promise<{ stdout: string; exit: number }> {
  const res = await input.sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `cd "${input.workDir}" && ${command}`],
  });
  return { stdout: await res.stdout(), exit: res.exitCode };
}
