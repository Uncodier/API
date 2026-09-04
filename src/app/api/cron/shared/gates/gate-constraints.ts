import type { FlowGateInput, FlowGateSignal } from './types';
import {
  extractRequirementConstraints,
  findConstraintViolations,
  type RequirementConstraint,
} from '@/lib/services/requirement-constraints';
import {
  countHttpsCitations,
  formatConstraintRetryHint,
  formatResearchCitationHint,
  isHarnessCycleCommit,
  isSafeArtifactPath,
  MIN_RESEARCH_HTTPS,
  parseFileNameList,
  partitionConstraintHits,
  shouldRequireResearchCitations,
  uniqueHitFiles,
  type ConstraintHit,
} from './constraint-scan';

async function loadConstraints(input: FlowGateInput): Promise<RequirementConstraint[]> {
  const { loadConstraintSourceBlocks } = await import('@/lib/services/requirement-constraints-persist');
  const persisted = await loadConstraintSourceBlocks(input.requirementId);
  return extractRequirementConstraints(
    ...(input.item?.constraints || []),
    ...(input.item?.acceptance || []),
    ...persisted,
  );
}

async function runInWorkDir(input: FlowGateInput, command: string): Promise<string> {
  const res = await input.sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `cd "${input.workDir}" && ${command}`],
  });
  return res.stdout();
}

async function listAllArtifactFiles(input: FlowGateInput): Promise<string[]> {
  const stdout = await runInWorkDir(
    input,
    `(git ls-files 'docs' 'artifacts' 'reports' 'outputs' 2>/dev/null; git ls-files --others --exclude-standard -- 'docs' 'artifacts' 'reports' 'outputs' 2>/dev/null) | sort -u | head -40`,
  );
  return parseFileNameList(stdout);
}

/** Files this step wrote: dirty tree + last agent checkpoint (not cron cycle-complete). */
async function listTouchedThisStep(input: FlowGateInput): Promise<Set<string>> {
  const subject = (await runInWorkDir(input, `git log -1 --pretty=%s 2>/dev/null`)).trim();
  const lastCommitNames = isHarnessCycleCommit(subject)
    ? ''
    : `git log --name-only -1 --pretty="" 2>/dev/null`;
  const stdout = await runInWorkDir(
    input,
    `(git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; ${lastCommitNames}) | sort -u`,
  );
  return new Set(parseFileNameList(stdout));
}

async function scanFiles(
  input: FlowGateInput,
  files: string[],
  constraints: RequirementConstraint[],
): Promise<ConstraintHit[]> {
  const violations: ConstraintHit[] = [];
  for (const file of files.slice(0, 20)) {
    const text = await runInWorkDir(input, `cat "${file}" 2>/dev/null | head -c 80000`);
    for (const hit of findConstraintViolations(text, constraints)) {
      violations.push({ ...hit, file });
    }
  }
  return violations;
}

async function removeStaleFiles(input: FlowGateInput, files: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const file of files) {
    if (!isSafeArtifactPath(file)) continue;
    await runInWorkDir(
      input,
      `git rm -f --ignore-unmatch -- "${file}" >/dev/null 2>&1 || rm -f -- "${file}"; echo done`,
    );
    removed.push(file);
  }
  return removed;
}

export async function runConstraintSignals(input: FlowGateInput): Promise<{
  signals: FlowGateSignal[];
  violations: ConstraintHit[];
  retryHint: string;
  staleRemoved: string[];
}> {
  const constraints = await loadConstraints(input);
  if (!constraints.length) {
    return {
      signals: [{ name: 'constraints', ok: true, detail: 'none declared' }],
      violations: [],
      retryHint: '',
      staleRemoved: [],
    };
  }

  const allFiles = await listAllArtifactFiles(input);
  const touched = await listTouchedThisStep(input);
  const firstScan = await scanFiles(input, allFiles, constraints);
  const { touchedHits, staleHits } = partitionConstraintHits(firstScan, touched);

  const staleRemoved = await removeStaleFiles(input, uniqueHitFiles(staleHits));

  const remaining = allFiles.filter((f) => !staleRemoved.includes(f));
  const secondScan = staleRemoved.length
    ? await scanFiles(input, remaining, constraints)
    : firstScan;
  const after = partitionConstraintHits(secondScan, touched);

  const ok = after.touchedHits.length === 0;
  const detail = ok
    ? staleRemoved.length
      ? `${constraints.length} constraints checked (removed ${staleRemoved.length} stale)`
      : `${constraints.length} constraints checked`
    : after.touchedHits.slice(0, 3).map((v) => `${v.file}: "${v.term}"`).join('; ');
  const retryHint = formatConstraintRetryHint(after.touchedHits);

  return {
    signals: [{ name: 'constraints', ok, detail }],
    violations: after.touchedHits,
    retryHint,
    staleRemoved,
  };
}

/** Research/doc steps must persist real https:// citations, not name-only lists. */
export async function runResearchCitationSignals(input: FlowGateInput): Promise<{
  signals: FlowGateSignal[];
  retryHint: string;
}> {
  const title = input.item?.title || '';
  const acceptance = (input.item?.acceptance || []).join(' ');
  const constraints = (input.item?.constraints || []).join(' ');
  if (!shouldRequireResearchCitations(title, acceptance, constraints, input.flow)) {
    return { signals: [], retryHint: '' };
  }

  const touched = await listTouchedThisStep(input);
  const mdFiles = [...touched].filter((f) => /\.mdx?$/i.test(f));
  if (!mdFiles.length) {
    return {
      signals: [{ name: 'research-citations', ok: false, detail: '0 https urls (no markdown written this step)' }],
      retryHint: formatResearchCitationHint(0),
    };
  }
  let found = 0;
  for (const file of mdFiles.slice(0, 12)) {
    const text = await runInWorkDir(input, `cat "${file}" 2>/dev/null | head -c 80000`);
    found += countHttpsCitations(text);
  }
  const ok = found >= MIN_RESEARCH_HTTPS;
  const retryHint = ok ? '' : formatResearchCitationHint(found);
  return {
    signals: [{ name: 'research-citations', ok, detail: `${found} https urls` }],
    retryHint,
  };
}
