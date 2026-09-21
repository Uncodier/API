import type { Sandbox } from '@vercel/sandbox';
import { posix } from 'node:path';
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
import {
  auditInternalLinks,
  type AuditedInternalLink,
  type UnresolvedInternalLink,
} from './step-interaction-links';

const WORK_DIR = '/vercel/sandbox';
const SOURCE_FILE_RE = /\.(?:tsx|jsx|ts|js)$/;

function resolveImportFile(
  fromFile: string,
  specifier: string,
  workspaceFiles: Set<string>,
): string | undefined {
  const base = specifier.startsWith('@/')
    ? `src/${specifier.slice(2)}`
    : specifier.startsWith('.')
      ? posix.normalize(posix.join(posix.dirname(fromFile), specifier))
      : null;
  if (!base) return undefined;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  return candidates.find((candidate) => workspaceFiles.has(candidate));
}

export function resolveLinkImportBindings(
  file: string,
  content: string,
  workspaceFiles: Set<string>,
): Record<string, string> {
  const bindings: Record<string, string> = {};
  const namedImport =
    /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of Array.from(content.matchAll(namedImport))) {
    const sourceFile = resolveImportFile(file, match[2], workspaceFiles);
    if (!sourceFile) continue;
    for (const rawBinding of match[1].split(',')) {
      const [importedRaw, localRaw] = rawBinding.trim().split(/\s+as\s+/i);
      const imported = importedRaw?.replace(/^type\s+/, '').trim();
      const local = (localRaw || imported)?.trim();
      if (imported && local) {
        bindings[local] = `${sourceFile}#${imported}`;
      }
    }
  }
  return bindings;
}

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
        `  git diff --unified=0 "${baseline}"..HEAD -- src/app src/components src/features src/hooks src/config src/lib public`,
        'else',
        '  BASE=""',
        '  git rev-parse --verify origin/main >/dev/null 2>&1 && BASE=origin/main',
        '  [ -z "$BASE" ] && git rev-parse --verify origin/master >/dev/null 2>&1 && BASE=origin/master',
        '  if [ -n "$BASE" ]; then git diff --unified=0 "$BASE"..HEAD -- src/app src/components src/features src/hooks src/config src/lib public; fi',
        'fi',
      ].join('\n')
    : [
        'BASE=""',
        'git rev-parse --verify origin/main >/dev/null 2>&1 && BASE=origin/main',
        '[ -z "$BASE" ] && git rev-parse --verify origin/master >/dev/null 2>&1 && BASE=origin/master',
        'if [ -n "$BASE" ]; then git diff --unified=0 "$BASE"..HEAD -- src/app src/components src/features src/hooks src/config src/lib public; fi',
      ].join('\n');
  const command = [
    'set -e',
    `cd "${WORK_DIR}"`,
    'git ls-files --cached --others --exclude-standard -- src/app src/components src/features src/hooks src/config src/lib public',
    'printf "\\n__UNTRACKED__\\n"',
    'git ls-files --others --exclude-standard -- src/app src/components src/features src/hooks src/config src/lib public',
    'printf "\\n__DIFF__\\n"',
    committedDiff,
    'git diff --unified=0 -- src/app src/components src/features src/hooks src/config src/lib public',
    'git diff --cached --unified=0 -- src/app src/components src/features src/hooks src/config src/lib public',
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
  const interactionSourceFiles = state.files.filter(
    (file) =>
      SOURCE_FILE_RE.test(file) &&
      !file.startsWith('src/app/api/') &&
      (file.startsWith('src/app/') ||
        file.startsWith('src/components/') ||
        file.startsWith('src/features/') ||
        file.startsWith('src/hooks/')),
  );
  const configSourceFiles = state.files.filter(
    (file) =>
      SOURCE_FILE_RE.test(file) &&
      (
        file.startsWith('src/config/') ||
        (
          file.startsWith('src/lib/') &&
          /(?:nav|navigation|menu|route|link)/i.test(file)
        )
      ),
  );
  const sourceFiles = Array.from(new Set([
    ...interactionSourceFiles,
    ...configSourceFiles,
  ]));
  const interactionSourceSet = new Set(interactionSourceFiles);
  const routePatterns = routes.map(routePattern);
  const workspaceFiles = new Set(state.files);
  const contents = new Map<string, string>();
  const interactiveClassNames = new Set<string>();
  for (const file of sourceFiles) {
    const content = await sandbox.fs.readFile(`${WORK_DIR}/${file}`, 'utf8').catch(() => null);
    if (content == null) continue;
    const text = typeof content === 'string' ? content : String(content);
    contents.set(file, text);
    if (interactionSourceSet.has(file)) {
      collectActionClassNames(file, text).forEach((token) =>
        interactiveClassNames.add(token),
      );
    }
  }
  const findings: InteractionFinding[] = [];
  const links: AuditedInternalLink[] = [];
  const unresolvedLinks: UnresolvedInternalLink[] = [];
  for (const [file, content] of Array.from(contents.entries())) {
    if (interactionSourceSet.has(file)) {
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
    const linkAudit = auditInternalLinks({
      file,
      content,
      routePatterns,
      publicFiles: state.publicFiles,
      importBindings: resolveLinkImportBindings(
        file,
        content,
        workspaceFiles,
      ),
    });
    links.push(...linkAudit.links);
    unresolvedLinks.push(...linkAudit.unresolved);
  }
  return {
    ...summarizeInteractionFindings(findings),
    evaluable: true,
    audited_files: sourceFiles,
    links,
    unresolved_links: unresolvedLinks,
  };
}
