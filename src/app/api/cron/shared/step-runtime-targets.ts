/**
 * Infer the page and API routes that a step touched, so the runtime probe
 * can focus its curl hits on what actually changed. Pure sandbox git work,
 * no assistant / LLM calls.
 */

import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

export type InferredTargetRoutes = {
  pageRoutes: string[];
  apiRoutes: Array<{ path: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' }>;
  changedFiles: string[];
};

const DEFAULT_METHOD: InferredTargetRoutes['apiRoutes'][number]['method'] = 'GET';

function pageRouteFromFile(rel: string): string | null {
  const m = rel.match(/^src\/app\/(.+)\/page\.(tsx|jsx|ts|js)$/);
  if (!m) return null;
  const segments = m[1].split('/');
  const cleaned = segments.filter((seg) => !seg.startsWith('(') || !seg.endsWith(')'));
  if (cleaned.some((seg) => seg.startsWith('[') && seg.endsWith(']'))) return null;
  const path = '/' + cleaned.join('/');
  return path === '/' ? '/' : path.replace(/\/$/, '');
}

function apiRouteFromFile(rel: string): string | null {
  const m = rel.match(/^src\/app\/api\/(.+)\/route\.(ts|js)$/);
  if (!m) return null;
  const segments = m[1].split('/');
  const cleaned = segments.filter((seg) => !seg.startsWith('(') || !seg.endsWith(')'));
  if (cleaned.some((seg) => seg.startsWith('[') && seg.endsWith(']'))) return null;
  return '/api/' + cleaned.join('/');
}

async function readChangedFiles(sandbox: Sandbox): Promise<string[]> {
  const wd = SandboxService.WORK_DIR;
  const cmds = [
    `cd ${wd}`,
    'CHANGED=""',
    'BASE=""',
    'if git rev-parse --verify HEAD >/dev/null 2>&1; then',
    '  if git rev-parse --verify origin/main >/dev/null 2>&1; then BASE=origin/main; fi',
    '  if [ -z "$BASE" ] && git rev-parse --verify origin/master >/dev/null 2>&1; then BASE=origin/master; fi',
    'fi',
    'if [ -n "$BASE" ]; then',
    '  CHANGED=$(git diff --name-only "$BASE"...HEAD 2>/dev/null; git status --porcelain 2>/dev/null | awk \'{print $2}\')',
    'else',
    '  CHANGED=$(git status --porcelain 2>/dev/null | awk \'{print $2}\')',
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

/**
 * Maps changed files to page / API routes. Dynamic route segments ([slug])
 * are intentionally skipped — the probe would need sample values to hit them.
 * The QA persona can declare scenarios/payloads for those.
 */
export async function inferTargetRoutesFromDiff(sandbox: Sandbox): Promise<InferredTargetRoutes> {
  const changedFiles = await readChangedFiles(sandbox);

  const pageRoutes = new Set<string>();
  const apiRoutes = new Map<string, InferredTargetRoutes['apiRoutes'][number]>();

  for (const rel of changedFiles) {
    const page = pageRouteFromFile(rel);
    if (page) pageRoutes.add(page);
    const api = apiRouteFromFile(rel);
    if (api && !apiRoutes.has(api)) {
      apiRoutes.set(api, { path: api, method: DEFAULT_METHOD });
    }
  }

  return {
    pageRoutes: Array.from(pageRoutes),
    apiRoutes: Array.from(apiRoutes.values()),
    changedFiles,
  };
}
