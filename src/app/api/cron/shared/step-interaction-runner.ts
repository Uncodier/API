import type { Sandbox } from '@vercel/sandbox';
import {
  auditInteractionSource,
  collectActionClassNames,
  parseAddedLines,
  parseChangedTargets,
  routeFromAppFile,
  routePattern,
  summarizeInteractionFindings,
  type InteractionFinding,
  type InteractionSignal,
} from './step-interaction-audit';

const WORK_DIR = '/vercel/sandbox';
const SOURCE_FILE_RE = /\.(?:tsx|jsx|ts|js)$/;

async function collectWorkspaceState(
  sandbox: Sandbox,
  baselineSha?: string | null,
): Promise<{
  files: string[];
  publicFiles: Set<string>;
  addedLines: Map<string, Set<number> | '*'>;
  changedTargets: Set<string>;
}> {
  const baseline = /^[0-9a-f]{7,64}$/i.test(baselineSha || '') ? baselineSha : null;
  const committedDiff = baseline
    ? [
        `if ! git cat-file -e "${baseline}^{commit}" >/dev/null 2>&1; then git fetch --quiet --no-tags --depth=1 origin "${baseline}" >/dev/null 2>&1 || true; fi`,
        `if git cat-file -e "${baseline}^{commit}" >/dev/null 2>&1; then`,
        `  git diff --unified=0 "${baseline}"..HEAD -- src/app src/components src/features src/hooks public`,
        'else',
        '  BASE=""',
        '  git rev-parse --verify origin/main >/dev/null 2>&1 && BASE=origin/main',
        '  [ -z "$BASE" ] && git rev-parse --verify origin/master >/dev/null 2>&1 && BASE=origin/master',
        '  if [ -n "$BASE" ]; then git diff --unified=0 "$BASE"..HEAD -- src/app src/components src/features src/hooks public; fi',
        'fi',
      ].join('\n')
    : [
        'BASE=""',
        'git rev-parse --verify origin/main >/dev/null 2>&1 && BASE=origin/main',
        '[ -z "$BASE" ] && git rev-parse --verify origin/master >/dev/null 2>&1 && BASE=origin/master',
        'if [ -n "$BASE" ]; then git diff --unified=0 "$BASE"..HEAD -- src/app src/components src/features src/hooks public; fi',
      ].join('\n');
  const command = [
    'set -e',
    `cd "${WORK_DIR}"`,
    'git ls-files --cached --others --exclude-standard -- src/app src/components src/features src/hooks public',
    'printf "\\n__UNTRACKED__\\n"',
    'git ls-files --others --exclude-standard -- src/app src/components src/features src/hooks public',
    'printf "\\n__DIFF__\\n"',
    committedDiff,
    'git diff --unified=0 -- src/app src/components src/features src/hooks public',
    'git diff --cached --unified=0 -- src/app src/components src/features src/hooks public',
  ].join('\n');
  const result = await sandbox.runCommand('sh', ['-c', command]);
  if (result.exitCode !== 0) {
    throw new Error(`Interaction audit workspace scan failed with exit ${result.exitCode}`);
  }
  const stdout = await result.stdout().catch(() => '');
  const [filesRaw = '', remainder = ''] = stdout.split('\n__UNTRACKED__\n');
  const [untrackedRaw = '', diff = ''] = remainder.split('\n__DIFF__\n');
  const files = filesRaw.split('\n').map((file) => file.trim()).filter(Boolean);
  const untracked = untrackedRaw.split('\n').map((file) => file.trim()).filter(Boolean);
  return {
    files,
    publicFiles: new Set(
      files.filter((file) => file.startsWith('public/')).map((file) => file.slice('public'.length)),
    ),
    addedLines: parseAddedLines(diff, untracked),
    changedTargets: parseChangedTargets(diff),
  };
}

export async function runInteractionAudit(
  sandbox: Sandbox,
  options?: { baselineSha?: string | null },
): Promise<InteractionSignal> {
  const state = await collectWorkspaceState(sandbox, options?.baselineSha);
  const routes = state.files.map(routeFromAppFile).filter((route): route is string => !!route);
  const sourceFiles = state.files.filter(
    (file) =>
      SOURCE_FILE_RE.test(file) &&
      !file.startsWith('src/app/api/') &&
      (file.startsWith('src/app/') ||
        file.startsWith('src/components/') ||
        file.startsWith('src/features/') ||
        file.startsWith('src/hooks/')),
  );
  const routePatterns = routes.map(routePattern);
  const contents = new Map<string, string>();
  const interactiveClassNames = new Set<string>();
  for (const file of sourceFiles) {
    const content = await sandbox.fs.readFile(`${WORK_DIR}/${file}`, 'utf8').catch(() => null);
    if (content == null) continue;
    const text = typeof content === 'string' ? content : String(content);
    contents.set(file, text);
    collectActionClassNames(file, text).forEach((token) => interactiveClassNames.add(token));
  }
  const findings: InteractionFinding[] = [];
  for (const [file, content] of Array.from(contents.entries())) {
    findings.push(...auditInteractionSource({
      file,
      content,
      routePatterns,
      publicFiles: state.publicFiles,
      addedLines: state.addedLines,
      changedTargets: state.changedTargets,
      interactiveClassNames,
    }));
  }
  return summarizeInteractionFindings(findings);
}
