/**
 * Infer the page and API routes that a step touched, so the runtime probe
 * can focus its curl hits on what actually changed. Pure sandbox git work,
 * no assistant / LLM calls.
 */

import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { routeFromAppFile } from './step-app-route';
import { inferAffectedPageFilesForChangeSets } from './step-visual-route-dependencies';

export type InferredTargetRoutes = {
  pageRoutes: string[];
  apiRoutes: Array<{ path: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' }>;
  changedFiles: string[];
  recentPageRoutes: string[];
  recentChangedFiles: string[];
};

const DEFAULT_METHOD: InferredTargetRoutes['apiRoutes'][number]['method'] = 'GET';
const HTTP_METHOD_PATTERN =
  /\b(?:export\s+(?:async\s+)?function|export\s+const)\s+(GET|POST|PUT|DELETE|PATCH)\b/g;

export function pageRouteFromFile(rel: string): string | null {
  if (!/^src\/app\/.*page\.(?:tsx|jsx|ts|js)$/.test(rel)) return null;
  const route = routeFromAppFile(rel);
  if (!route || route.split('/').some((segment) => segment.includes('['))) {
    return null;
  }
  return route;
}

function apiRouteFromFile(rel: string): string | null {
  const m = rel.match(/^src\/app\/api\/(.+)\/route\.(ts|js)$/);
  if (!m) return null;
  const segments = m[1].split('/');
  const cleaned = segments.filter((seg) => !seg.startsWith('(') || !seg.endsWith(')'));
  if (cleaned.some((seg) => seg.startsWith('[') && seg.endsWith(']'))) return null;
  return '/api/' + cleaned.join('/');
}

async function methodsFromApiFile(
  sandbox: Sandbox,
  rel: string,
): Promise<InferredTargetRoutes['apiRoutes'][number]['method'][]> {
  try {
    const source = await sandbox.fs.readFile(
      `${SandboxService.WORK_DIR}/${rel}`,
      'utf8',
    );
    const text = typeof source === 'string' ? source : String(source ?? '');
    const methods = new Set<
      InferredTargetRoutes['apiRoutes'][number]['method']
    >();
    let match: RegExpExecArray | null;
    HTTP_METHOD_PATTERN.lastIndex = 0;
    while ((match = HTTP_METHOD_PATTERN.exec(text))) {
      methods.add(
        match[1] as InferredTargetRoutes['apiRoutes'][number]['method'],
      );
    }
    return methods.size ? Array.from(methods) : [DEFAULT_METHOD];
  } catch {
    return [DEFAULT_METHOD];
  }
}

async function readChangedFiles(sandbox: Sandbox): Promise<string[]> {
  const wd = SandboxService.WORK_DIR;
  const cmds = [
    `cd ${wd}`,
    'CHANGED=""',
    'BASE=""',
    'if git rev-parse --verify origin/main >/dev/null 2>&1; then BASE=origin/main; fi',
    'if [ -z "$BASE" ] && git rev-parse --verify origin/master >/dev/null 2>&1; then BASE=origin/master; fi',
    'if [ -z "$BASE" ]; then',
    '  DEF=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s@^refs/remotes/@@")',
    '  if [ -n "$DEF" ] && git rev-parse --verify "$DEF" >/dev/null 2>&1; then BASE="$DEF"; fi',
    'fi',
    'if [ -n "$BASE" ]; then',
    '  CHANGED=$(git diff --name-only --diff-filter=ACMRTUXB "$BASE"...HEAD 2>/dev/null; git diff --name-only --diff-filter=ACMRTUXB 2>/dev/null; git diff --cached --name-only --diff-filter=ACMRTUXB 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null)',
    'else',
    '  CHANGED=$(git diff --name-only --diff-filter=ACMRTUXB 2>/dev/null; git diff --cached --name-only --diff-filter=ACMRTUXB 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null)',
    'fi',
    'printf "%s\\n" "$CHANGED" | sort -u | awk "NF>0"',
  ].join('\n');

  const r = await sandbox.runCommand('sh', ['-c', cmds]);
  if (r.exitCode !== 0) return [];
  const out = await r.stdout().catch(() => '');
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

async function readRecentChangedFiles(
  sandbox: Sandbox,
  baselineSha?: string | null,
): Promise<string[]> {
  const wd = SandboxService.WORK_DIR;
  const baseline = /^[0-9a-f]{7,64}$/i.test(baselineSha || '') ? baselineSha : '';
  const command = [
    `cd ${wd}`,
    `BASELINE=${JSON.stringify(baseline)}`,
    'if [ -n "$BASELINE" ] && ! git cat-file -e "$BASELINE^{commit}" >/dev/null 2>&1; then git fetch --quiet --no-tags --depth=1 origin "$BASELINE" >/dev/null 2>&1 || true; fi',
    'if [ -n "$BASELINE" ] && git cat-file -e "$BASELINE^{commit}" >/dev/null 2>&1; then',
    '  git diff --name-only --diff-filter=ACMRTUXB "$BASELINE"..HEAD 2>/dev/null || true',
    'else',
    '  BASE=""',
    '  git rev-parse --verify origin/main >/dev/null 2>&1 && BASE=origin/main',
    '  [ -z "$BASE" ] && git rev-parse --verify origin/master >/dev/null 2>&1 && BASE=origin/master',
    '  if [ -n "$BASE" ]; then git diff --name-only --diff-filter=ACMRTUXB "$BASE"..HEAD 2>/dev/null || true; else git show --pretty="" --name-only --diff-filter=ACMRTUXB HEAD 2>/dev/null || true; fi',
    'fi',
    'git diff --name-only --diff-filter=ACMRTUXB 2>/dev/null || true',
    'git diff --cached --name-only --diff-filter=ACMRTUXB 2>/dev/null || true',
    'git ls-files --others --exclude-standard 2>/dev/null || true',
  ].join('\n');
  const result = await sandbox.runCommand('sh', ['-c', command]);
  if (result.exitCode !== 0) return [];
  const output = await result.stdout().catch(() => '');
  return Array.from(
    new Set(output.split('\n').map((line) => line.trim()).filter(Boolean)),
  );
}

/**
 * Maps changed files to page / API routes. Dynamic route segments ([slug])
 * are intentionally skipped — the probe would need sample values to hit them.
 * The QA persona can declare scenarios/payloads for those.
 */
export async function inferTargetRoutesFromDiff(
  sandbox: Sandbox,
  options?: { baselineSha?: string | null },
): Promise<InferredTargetRoutes> {
  const [changedFiles, recentChangedFiles] = await Promise.all([
    readChangedFiles(sandbox),
    readRecentChangedFiles(sandbox, options?.baselineSha),
  ]);
  const [affectedPageFiles, recentAffectedPageFiles] =
    await inferAffectedPageFilesForChangeSets(
      sandbox,
      [changedFiles, recentChangedFiles],
    ).catch((error: unknown) => {
      console.warn(
        '[RuntimeTargets] Could not infer component-to-page dependencies:',
        error instanceof Error ? error.message : error,
      );
      return [[], []];
    });

  const pageRoutes = new Set<string>();
  const apiRoutes = new Map<string, InferredTargetRoutes['apiRoutes'][number]>();

  for (const rel of changedFiles) {
    const page = pageRouteFromFile(rel);
    if (page) pageRoutes.add(page);
    const api = apiRouteFromFile(rel);
    if (api) {
      const methods = await methodsFromApiFile(sandbox, rel);
      for (const method of methods) {
        apiRoutes.set(`${method} ${api}`, { path: api, method });
      }
    }
  }
  for (const page of affectedPageFiles.map(pageRouteFromFile)) {
    if (page) pageRoutes.add(page);
  }

  const recentPageRoutes = [...recentChangedFiles, ...recentAffectedPageFiles]
    .map(pageRouteFromFile)
    .filter((route): route is string => !!route);

  return {
    pageRoutes: Array.from(pageRoutes),
    apiRoutes: Array.from(apiRoutes.values()),
    changedFiles,
    recentPageRoutes: Array.from(new Set(recentPageRoutes)),
    recentChangedFiles,
  };
}
