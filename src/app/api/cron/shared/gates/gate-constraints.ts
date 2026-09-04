import type { FlowGateInput, FlowGateSignal } from './types';
import {
  extractRequirementConstraints,
  findConstraintViolations,
  type RequirementConstraint,
} from '@/lib/services/requirement-constraints';

async function loadConstraints(input: FlowGateInput): Promise<RequirementConstraint[]> {
  const { loadConstraintSourceBlocks } = await import('@/lib/services/requirement-constraints-persist');
  const persisted = await loadConstraintSourceBlocks(input.requirementId);
  return extractRequirementConstraints(
    ...(input.item?.constraints || []),
    ...(input.item?.acceptance || []),
    ...persisted,
  );
}

export async function runConstraintSignals(input: FlowGateInput): Promise<{
  signals: FlowGateSignal[];
  violations: Array<{ constraint: string; term: string; quote: string; file?: string }>;
}> {
  const constraints = await loadConstraints(input);
  if (!constraints.length) {
    return { signals: [{ name: 'constraints', ok: true, detail: 'none declared' }], violations: [] };
  }

  const list = await input.sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `cd "${input.workDir}" && (git diff --name-only @{upstream}...HEAD 2>/dev/null; git diff --name-only HEAD 2>/dev/null; git ls-files 'docs' 'artifacts' 'reports' 'outputs' 2>/dev/null) | sort -u | head -40`,
    ],
  });
  const files = (await list.stdout()).split('\n').map((s) => s.trim()).filter((f) => /\.(md|mdx|txt|json)$/i.test(f));
  const violations: Array<{ constraint: string; term: string; quote: string; file?: string }> = [];

  for (const file of files.slice(0, 20)) {
    const cat = await input.sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', `cd "${input.workDir}" && cat "${file}" 2>/dev/null | head -c 80000`],
    });
    const text = await cat.stdout();
    for (const hit of findConstraintViolations(text, constraints)) {
      violations.push({ ...hit, file });
    }
  }

  const ok = violations.length === 0;
  const detail = ok
    ? `${constraints.length} constraints checked`
    : violations.slice(0, 3).map((v) => `${v.file}: "${v.term}"`).join('; ');
  return {
    signals: [{ name: 'constraints', ok, detail }],
    violations,
  };
}
