import type { FlowGateInput, FlowGateSignal } from './types';
import {
  extractRequirementConstraints,
  findConstraintViolations,
  type RequirementConstraint,
} from '@/lib/services/requirement-constraints';
import {
  countResearchCitations,
  extractAddedDiffLines,
  extractNamedMarkdownPaths,
  formatConstraintRetryHint,
  formatResearchCitationHint,
  isHarnessCycleCommit,
  isSafeArtifactPath,
  MIN_RESEARCH_HTTPS,
  parseFileNameList,
  partitionConstraintHits,
  resolveResearchCitationTargets,
  shouldRequireResearchCitations,
  splitScanTargets,
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

async function isUntrackedFile(input: FlowGateInput, file: string): Promise<boolean> {
  const status = (await runInWorkDir(input, `git status --porcelain -- "${file}" 2>/dev/null`)).trim();
  return status.startsWith('??') || status.startsWith('A ');
}

async function addedHunksForFile(input: FlowGateInput, file: string): Promise<string> {
  if (await isUntrackedFile(input, file)) {
    return runInWorkDir(input, `cat "${file}" 2>/dev/null | head -c 80000`);
  }
  const subject = (await runInWorkDir(input, `git log -1 --pretty=%s 2>/dev/null`)).trim();
  const parts = [
    await runInWorkDir(input, `git diff -U0 HEAD -- "${file}" 2>/dev/null`),
    await runInWorkDir(input, `git diff -U0 --cached -- "${file}" 2>/dev/null`),
  ];
  if (!isHarnessCycleCommit(subject)) {
    parts.push(await runInWorkDir(input, `git diff -U0 HEAD~1 HEAD -- "${file}" 2>/dev/null`));
  }
  return extractAddedDiffLines(parts.join('\n'));
}

async function scanFiles(
  input: FlowGateInput,
  files: string[],
  constraints: RequirementConstraint[],
  opts?: { hunksOnly?: boolean },
): Promise<ConstraintHit[]> {
  const violations: ConstraintHit[] = [];
  const hunksOnly = opts?.hunksOnly !== false;
  for (const file of files.slice(0, 20)) {
    const text = hunksOnly
      ? await addedHunksForFile(input, file)
      : await runInWorkDir(input, `cat "${file}" 2>/dev/null | head -c 80000`);
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
  inheritedHits: ConstraintHit[];
  skipAttemptBump: boolean;
}> {
  const constraints = await loadConstraints(input);
  if (!constraints.length) {
    return {
      signals: [{ name: 'constraints', ok: true, detail: 'none declared' }],
      violations: [],
      retryHint: '',
      staleRemoved: [],
      inheritedHits: [],
      skipAttemptBump: false,
    };
  }

  const allFiles = await listAllArtifactFiles(input);
  const touched = await listTouchedThisStep(input);
  const { hunkFiles, staleFiles } = splitScanTargets(allFiles, touched);
  const firstHunkHits = await scanFiles(input, hunkFiles, constraints, { hunksOnly: true });
  const firstStaleHits = await scanFiles(input, staleFiles, constraints, { hunksOnly: false });

  const staleRemoved = await removeStaleFiles(input, uniqueHitFiles(firstStaleHits));

  const remainingHunk = hunkFiles.filter((f) => !staleRemoved.includes(f));
  const hunkHits = staleRemoved.length
    ? await scanFiles(input, remainingHunk, constraints, { hunksOnly: true })
    : firstHunkHits;
  const after = partitionConstraintHits(hunkHits, touched);

  const fullScan = await scanFiles(input, remainingHunk, constraints, { hunksOnly: false });
  const inheritedHits = fullScan.filter((hit) => {
    return !after.touchedHits.some(
      (t) => t.file === hit.file && t.term === hit.term && t.quote === hit.quote,
    );
  });

  const ok = after.touchedHits.length === 0;
  const skipAttemptBump = after.touchedHits.length === 0 && inheritedHits.length > 0;
  const detail = ok
    ? staleRemoved.length
      ? `${constraints.length} constraints checked (removed ${staleRemoved.length} stale)`
      : inheritedHits.length
        ? `${constraints.length} constraints checked (ignored ${inheritedHits.length} inherited)`
        : `${constraints.length} constraints checked`
    : after.touchedHits.slice(0, 3).map((v) => `${v.file}: "${v.term}"`).join('; ');
  const retryHint = formatConstraintRetryHint(after.touchedHits);

  return {
    signals: [{ name: 'constraints', ok, detail }],
    violations: after.touchedHits,
    retryHint,
    staleRemoved,
    inheritedHits,
    skipAttemptBump,
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

  const existing = await listAllArtifactFiles(input);
  const existingMd = existing.filter((f) => /\.mdx?$/i.test(f));
  const namedInStep = extractNamedMarkdownPaths(
    input.item?.title,
    ...(input.item?.acceptance || []),
    ...(input.item?.constraints || []),
    input.appContext?.stepContext?.title,
    input.appContext?.stepContext?.instructions,
    input.appContext?.stepContext?.expected_output,
    input.appContext?.stepPrompt,
  );
  const touched = await listTouchedThisStep(input);
  const targets = resolveResearchCitationTargets({
    existingMarkdown: existingMd,
    namedInStep,
    touchedThisStep: touched,
  });
  if (targets.missing) {
    return {
      signals: [{
        name: 'research-citations',
        ok: false,
        detail: '0 https urls (research markdown does not exist)',
      }],
      retryHint: formatResearchCitationHint(0),
    };
  }
  let found = 0;
  for (const file of targets.files.slice(0, 12)) {
    const text = await runInWorkDir(input, `cat "${file}" 2>/dev/null | head -c 80000`);
    found += countResearchCitations(text);
  }
  const ok = found >= MIN_RESEARCH_HTTPS;
  const retryHint = ok ? '' : formatResearchCitationHint(found);
  return {
    signals: [{ name: 'research-citations', ok, detail: `${found} https urls` }],
    retryHint,
  };
}
