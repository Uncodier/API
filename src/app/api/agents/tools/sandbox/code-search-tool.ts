/**
 * sandbox_code_search — multi-action navigation/search tool for the coding agent.
 *
 * Replaces the noisy combo of `ls`/`grep`/`find` shelled out via sandbox_run_command
 * with structured, capped, agent-friendly results. Two backends are bootstrapped
 * lazily on first call (cached per Sandbox instance):
 *   - ripgrep (rg)        → exact text + file listing, respects .gitignore
 *   - ast-grep (sg)       → structural / AST-aware symbol search (tree-sitter)
 *
 * Actions:
 *   - find_files   : list files by glob (e.g. "src/app/api/**\/route.ts")
 *   - grep         : regex content search with file/line/snippet results
 *   - find_symbol  : structural pattern search (function/class/component/...)
 *   - tree         : compact directory summary (depth-limited)
 *
 * All outputs are capped (`max_results`) and tag `truncated: true` when results
 * were cut, so the LLM context never explodes on large monorepos.
 */
import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

type RunResult = { stdout: string; stderr: string; exitCode: number };

const WORK_DIR = SandboxService.WORK_DIR;
const BIN_DIR = '/tmp/agent-bin';
const RG_BIN = `${BIN_DIR}/rg`;
const RG_VERSION = '14.1.1';

const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'dist',
  'build',
  'coverage',
  '.cache',
];

const SUPPORTED_LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'ruby',
  'cpp',
  'c',
  'csharp',
  'html',
  'css',
  'json',
  'yaml',
  'php',
] as const;
type SupportedLang = (typeof SUPPORTED_LANGS)[number];

type EnsureBins = { rg: boolean; sg: boolean; install_log?: string };
const ensureCache = new WeakMap<Sandbox, Promise<EnsureBins>>();

async function shRun(sandbox: Sandbox, script: string, cwd?: string): Promise<RunResult> {
  const res = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', script],
    ...(cwd ? { cwd } : {}),
  });
  return {
    stdout: await res.stdout(),
    stderr: await res.stderr(),
    exitCode: res.exitCode,
  };
}

/**
 * Detect rg/sg in PATH (or our local bin dir) and install when missing.
 * Result is cached per Sandbox so subsequent tool calls in the same VM are no-ops.
 */
async function ensureSearchBinaries(sandbox: Sandbox): Promise<EnsureBins> {
  const cached = ensureCache.get(sandbox);
  if (cached) return cached;

  const job = (async (): Promise<EnsureBins> => {
    const installLog: string[] = [];
    await shRun(sandbox, `mkdir -p ${BIN_DIR}`);

    // ripgrep ---------------------------------------------------------------
    let rg = false;
    const rgProbe = await shRun(
      sandbox,
      `if [ -x "${RG_BIN}" ]; then echo "${RG_BIN}"; else command -v rg || true; fi`,
    );
    if (rgProbe.stdout.trim().length > 0) {
      rg = true;
    } else {
      const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`;
      const dirName = `ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl`;
      const install = await shRun(
        sandbox,
        [
          'set -e',
          `cd /tmp`,
          `curl -fsSL "${url}" -o rg.tar.gz`,
          `tar -xzf rg.tar.gz`,
          `cp ${dirName}/rg ${RG_BIN}`,
          `chmod +x ${RG_BIN}`,
          `rm -rf rg.tar.gz ${dirName}`,
        ].join(' && '),
      );
      if (install.exitCode === 0) {
        rg = true;
      } else {
        installLog.push(`rg install failed: ${install.stderr.trim() || install.stdout.trim()}`);
      }
    }

    // ast-grep --------------------------------------------------------------
    let sg = false;
    const sgProbe = await shRun(sandbox, `command -v sg || command -v ast-grep || true`);
    if (sgProbe.stdout.trim().length > 0) {
      sg = true;
    } else {
      // @ast-grep/cli is the official npm distribution. npm is always present
      // in the node24 sandbox runtime, so this is the most reliable path.
      const install = await shRun(
        sandbox,
        `npm install -g @ast-grep/cli >/tmp/sg-install.log 2>&1 && command -v sg`,
      );
      if (install.exitCode === 0) {
        sg = true;
      } else {
        const log = await shRun(sandbox, `tail -c 4000 /tmp/sg-install.log 2>/dev/null || true`);
        installLog.push(`sg install failed: ${log.stdout.trim() || install.stderr.trim()}`);
      }
    }

    return {
      rg,
      sg,
      ...(installLog.length ? { install_log: installLog.join(' | ') } : {}),
    };
  })();

  ensureCache.set(sandbox, job);
  return job;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(v, min), max);
}

function resolveScope(path: string | undefined): string {
  if (!path || !path.trim()) return WORK_DIR;
  if (path.startsWith('/')) return path;
  return `${WORK_DIR}/${path}`.replace(/\/+/g, '/');
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildExcludeFlags(extra: string[] = []): string {
  const all = [...DEFAULT_EXCLUDES, ...extra];
  return all.map((dir) => `-g '!${dir}/**'`).join(' ');
}

// ---- find_files -----------------------------------------------------------

async function actionFindFiles(
  sandbox: Sandbox,
  args: { glob?: string; path?: string; max_results?: number },
) {
  const limit = clampInt(args.max_results, 200, 1, 1000);
  const scope = resolveScope(args.path);
  const include = args.glob && args.glob.trim().length > 0 ? `-g ${shellEscape(args.glob.trim())}` : '';
  const cmd = `${RG_BIN} --files --hidden --no-messages ${buildExcludeFlags()} ${include} ${shellEscape(scope)}`;
  const res = await shRun(sandbox, cmd);
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    return {
      ok: false,
      error: `rg --files failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
    };
  }
  const lines = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const truncated = lines.length > limit;
  return {
    ok: true,
    scope,
    glob: args.glob ?? null,
    count: lines.length,
    truncated,
    files: (truncated ? lines.slice(0, limit) : lines).map((p) => p.replace(`${WORK_DIR}/`, '')),
    ...(truncated
      ? { hint: `Hit max_results=${limit} of ${lines.length}. Tighten glob or path to narrow.` }
      : {}),
  };
}

// ---- grep -----------------------------------------------------------------

async function actionGrep(
  sandbox: Sandbox,
  args: {
    pattern?: string;
    glob?: string;
    path?: string;
    case_insensitive?: boolean;
    multiline?: boolean;
    context?: number;
    max_results?: number;
  },
) {
  const pattern = (args.pattern ?? '').trim();
  if (!pattern) return { ok: false, error: 'pattern is required for grep.' };
  const limit = clampInt(args.max_results, 100, 1, 500);
  const context = clampInt(args.context, 0, 0, 5);
  const scope = resolveScope(args.path);
  const include = args.glob && args.glob.trim().length > 0 ? `-g ${shellEscape(args.glob.trim())}` : '';
  const flags = [
    '--no-heading',
    '--line-number',
    '--with-filename',
    '--color=never',
    '--no-messages',
    '--max-count=200', // per-file cap; total cap applied below
    args.case_insensitive ? '-i' : '',
    args.multiline ? '-U --multiline-dotall' : '',
    context > 0 ? `-C ${context}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const cmd = `${RG_BIN} ${flags} ${buildExcludeFlags()} ${include} -e ${shellEscape(pattern)} ${shellEscape(scope)}`;
  const res = await shRun(sandbox, cmd);
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    return { ok: false, error: `rg failed (exit ${res.exitCode}): ${res.stderr.trim()}` };
  }

  type Match = { file: string; line: number; text: string };
  const matches: Match[] = [];
  for (const raw of res.stdout.split('\n')) {
    if (!raw) continue;
    // rg -n with --with-filename: "<path>:<line>:<text>" (or "-" between file:line for context lines)
    const sep = raw.indexOf(':');
    if (sep <= 0) continue;
    const rest = raw.slice(sep + 1);
    const sep2 = rest.indexOf(':');
    if (sep2 <= 0) continue;
    const lineStr = rest.slice(0, sep2);
    const text = rest.slice(sep2 + 1);
    const line = parseInt(lineStr, 10);
    if (!Number.isFinite(line)) continue;
    const file = raw.slice(0, sep).replace(`${WORK_DIR}/`, '');
    matches.push({ file, line, text: text.length > 400 ? `${text.slice(0, 400)}…` : text });
    if (matches.length >= limit) break;
  }
  const truncated = matches.length >= limit;
  return {
    ok: true,
    pattern,
    scope,
    count: matches.length,
    truncated,
    matches,
    ...(truncated
      ? { hint: `Hit max_results=${limit}. Add a glob or path filter to narrow.` }
      : {}),
  };
}

// ---- find_symbol ----------------------------------------------------------

async function actionFindSymbol(
  sandbox: Sandbox,
  args: { pattern?: string; lang?: string; path?: string; max_results?: number },
  bins: EnsureBins,
) {
  if (!bins.sg) {
    return {
      ok: false,
      error:
        'ast-grep (sg) is not available. Install failed at bootstrap. Use action=grep with a regex as fallback.',
      install_log: bins.install_log,
    };
  }
  const pattern = (args.pattern ?? '').trim();
  if (!pattern) {
    return {
      ok: false,
      error:
        'pattern is required (ast-grep syntax). Use $NAME / $$$ARGS as wildcards. Examples: "function $NAME($$$) { $$$ }", "<$COMP $$$/>", "class $NAME extends $BASE { $$$ }".',
    };
  }
  const lang = (args.lang ?? '').trim().toLowerCase();
  if (!lang || !SUPPORTED_LANGS.includes(lang as SupportedLang)) {
    return {
      ok: false,
      error: `lang is required and must be one of: ${SUPPORTED_LANGS.join(', ')}.`,
    };
  }
  const limit = clampInt(args.max_results, 50, 1, 300);
  const scope = resolveScope(args.path);
  const cmd = `sg run --pattern ${shellEscape(pattern)} --lang ${lang} --json=stream ${shellEscape(scope)}`;
  const res = await shRun(sandbox, cmd);
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    return { ok: false, error: `sg failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}` };
  }

  type SgHit = {
    file: string;
    line: number;
    end_line: number;
    column: number;
    text: string;
  };
  const hits: SgHit[] = [];
  for (const raw of res.stdout.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const obj = JSON.parse(raw) as {
        file?: string;
        text?: string;
        range?: {
          start?: { line?: number; column?: number };
          end?: { line?: number };
        };
      };
      const file = (obj.file ?? '').replace(`${WORK_DIR}/`, '');
      const line = (obj.range?.start?.line ?? 0) + 1;
      const endLine = (obj.range?.end?.line ?? obj.range?.start?.line ?? 0) + 1;
      const column = (obj.range?.start?.column ?? 0) + 1;
      const text = (obj.text ?? '').slice(0, 400);
      hits.push({ file, line, end_line: endLine, column, text });
      if (hits.length >= limit) break;
    } catch {
      // ignore non-JSON noise lines
    }
  }
  const truncated = hits.length >= limit;
  return {
    ok: true,
    lang,
    pattern,
    scope,
    count: hits.length,
    truncated,
    hits,
    ...(truncated ? { hint: `Hit max_results=${limit}. Tighten pattern or scope to narrow.` } : {}),
  };
}

// ---- tree -----------------------------------------------------------------

async function actionTree(sandbox: Sandbox, args: { path?: string; max_depth?: number }) {
  const scope = resolveScope(args.path);
  const depth = clampInt(args.max_depth, 3, 1, 6);
  const cmd = `${RG_BIN} --files --hidden --no-messages ${buildExcludeFlags()} ${shellEscape(scope)}`;
  const res = await shRun(sandbox, cmd);
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    return { ok: false, error: `rg --files failed (exit ${res.exitCode}): ${res.stderr.trim()}` };
  }
  const counts = new Map<string, number>();
  let total = 0;
  for (const raw of res.stdout.split('\n')) {
    const file = raw.trim();
    if (!file) continue;
    total += 1;
    const rel = file.startsWith(`${scope}/`) ? file.slice(scope.length + 1) : file;
    const parts = rel.split('/');
    // Aggregate at every depth up to `depth` (so the agent sees both shallow + nested totals).
    for (let d = 1; d <= Math.min(depth, parts.length - 1); d += 1) {
      const key = parts.slice(0, d).join('/');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (parts.length === 1) {
      counts.set('', (counts.get('') ?? 0) + 1);
    }
  }
  const entries = Array.from(counts.entries())
    .filter(([k]) => k.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, files]) => ({ dir, files }));
  return {
    ok: true,
    scope,
    max_depth: depth,
    total_files: total,
    directories: entries,
    ...(entries.length === 0 ? { hint: 'No files found in scope (or all excluded).' } : {}),
  };
}

// ---- tool factory ---------------------------------------------------------

export function sandboxCodeSearchTool(sandbox: Sandbox) {
  return {
    name: 'sandbox_code_search',
    description:
      'Navigate and search the cloned repository inside the sandbox WITHOUT shelling out raw grep/find. Backed by ripgrep (text + file listing, respects .gitignore) and ast-grep (AST-aware symbol search). Always prefer this over sandbox_run_command for searches — results are structured, capped, and noise-filtered. Actions: find_files | grep | find_symbol | tree. Bootstrap (binary install) runs once per sandbox on first call.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['find_files', 'grep', 'find_symbol', 'tree'],
          description:
            'find_files: list files by glob. grep: regex content search. find_symbol: AST-aware structural search via ast-grep (best for functions/components/classes). tree: directory summary with file counts.',
        },
        pattern: {
          type: 'string',
          description:
            'For grep: regex (ripgrep syntax). For find_symbol: ast-grep pattern using $NAME / $$$ARGS metavariables, e.g. "function $NAME($$$) { $$$ }", "<$COMP $$$/>", "class $NAME extends $BASE { $$$ }".',
        },
        glob: {
          type: 'string',
          description:
            'find_files / grep: include glob filter (e.g. "**/*.tsx", "src/app/api/**/route.ts"). Excludes node_modules, .next, .git, dist, build, coverage by default.',
        },
        lang: {
          type: 'string',
          enum: [...SUPPORTED_LANGS],
          description: 'find_symbol only: language for the tree-sitter parser.',
        },
        path: {
          type: 'string',
          description: `Subdirectory to scope the search to. Relative to ${WORK_DIR} or absolute. Defaults to the repo root.`,
        },
        case_insensitive: {
          type: 'boolean',
          description: 'grep only: case-insensitive match. Default false.',
        },
        multiline: {
          type: 'boolean',
          description: 'grep only: enable multiline matching (. matches \\n). Default false.',
        },
        context: {
          type: 'number',
          description: 'grep only: lines of context around each match (0..5). Default 0.',
        },
        max_depth: {
          type: 'number',
          description: 'tree only: max directory depth (1..6). Default 3.',
        },
        max_results: {
          type: 'number',
          description:
            'Cap on results. find_files default 200 (max 1000). grep default 100 (max 500). find_symbol default 50 (max 300).',
        },
      },
      required: ['action'],
    },
    execute: async (args: {
      action: 'find_files' | 'grep' | 'find_symbol' | 'tree';
      pattern?: string;
      glob?: string;
      lang?: string;
      path?: string;
      case_insensitive?: boolean;
      multiline?: boolean;
      context?: number;
      max_depth?: number;
      max_results?: number;
    }) => {
      const bins = await ensureSearchBinaries(sandbox);
      if (!bins.rg && (args.action === 'find_files' || args.action === 'grep' || args.action === 'tree')) {
        return {
          ok: false,
          error:
            'ripgrep (rg) is not available and could not be installed. Fall back to sandbox_run_command with grep/find.',
          install_log: bins.install_log,
        };
      }
      switch (args.action) {
        case 'find_files':
          return actionFindFiles(sandbox, args);
        case 'grep':
          return actionGrep(sandbox, args);
        case 'find_symbol':
          return actionFindSymbol(sandbox, args, bins);
        case 'tree':
          return actionTree(sandbox, args);
        default:
          return { ok: false, error: `Unknown action: ${(args as { action: string }).action}` };
      }
    },
  };
}
