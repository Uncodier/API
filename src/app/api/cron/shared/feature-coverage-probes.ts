import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

export type CoverageProbeOutcome = 'pass' | 'fail' | 'not_evaluable';

export interface ArtifactProof {
  path: string;
  exists: boolean;
  outcome: CoverageProbeOutcome;
  bytes?: number;
  content_excerpt?: string;
  error?: string;
}

export interface FileProbeResult {
  file: string | null;
  outcome: CoverageProbeOutcome;
  detail?: string;
}

interface ExistenceProbe {
  outcome: CoverageProbeOutcome;
  detail?: string;
}

async function existsInSandbox(
  sandbox: Sandbox,
  relPath: string,
): Promise<ExistenceProbe> {
  const wd = SandboxService.WORK_DIR;
  try {
    const result = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `[ -e "${wd}/${relPath}" ] && echo __OK__ || echo __MISS__`,
      ],
    });
    const output = (await result.stdout()).toString().trim();
    if (output === '__OK__') return { outcome: 'pass' };
    if (output === '__MISS__') return { outcome: 'fail' };
    return {
      outcome: 'not_evaluable',
      detail: `Unexpected existence-probe output for ${relPath}`,
    };
  } catch (error: unknown) {
    return {
      outcome: 'not_evaluable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function normalizeTouchPath(path: string): string {
  const normalized = path.trim().replace(/^\.?\//, '');
  return normalized.startsWith('app/')
    ? `src/${normalized}`
    : normalized;
}

export async function readArtifactProof(
  sandbox: Sandbox,
  relPath: string,
): Promise<ArtifactProof> {
  const normalized = normalizeTouchPath(relPath);
  if (/[*?[\]]/.test(normalized)) {
    return { path: normalized, exists: false, outcome: 'fail' };
  }
  const absolutePath = `${SandboxService.WORK_DIR}/${normalized}`;
  try {
    const stat = await sandbox.runCommand({
      cmd: 'stat',
      args: ['-c', '%s', absolutePath],
    });
    if (stat.exitCode !== 0) {
      return { path: normalized, exists: false, outcome: 'fail' };
    }
    const bytes = Number((await stat.stdout()).toString().trim());
    const read = await sandbox.runCommand({
      cmd: 'head',
      args: ['-c', '4000', absolutePath],
    });
    if (read.exitCode !== 0) {
      return {
        path: normalized,
        exists: true,
        outcome: 'not_evaluable',
        error: `Could not read ${normalized}`,
      };
    }
    const content = (await read.stdout()).toString();
    return {
      path: normalized,
      exists: true,
      outcome: 'pass',
      bytes: Number.isFinite(bytes) ? bytes : undefined,
      content_excerpt: content.replace(/\0/g, '').slice(0, 4000),
    };
  } catch (error: unknown) {
    return {
      path: normalized,
      exists: false,
      outcome: 'not_evaluable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function globCount(
  sandbox: Sandbox,
  pattern: string,
): Promise<{
  count: number;
  outcome: CoverageProbeOutcome;
  detail?: string;
}> {
  const wd = SandboxService.WORK_DIR;
  try {
    const result = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `cd "${wd}" && ls -1 ${pattern} 2>/dev/null | wc -l | awk '{print $1}'`,
      ],
    });
    const parsed = Number((await result.stdout()).toString().trim());
    if (!Number.isFinite(parsed)) {
      return {
        count: 0,
        outcome: 'not_evaluable',
        detail: `Unexpected glob-count output for ${pattern}`,
      };
    }
    return { count: parsed, outcome: 'pass' };
  } catch (error: unknown) {
    return {
      count: 0,
      outcome: 'not_evaluable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function findRouteFile(
  sandbox: Sandbox,
  basePath: string,
  extensions: string[],
): Promise<FileProbeResult> {
  const errors: string[] = [];
  for (const extension of extensions) {
    const path = `${basePath}.${extension}`;
    const probe = await existsInSandbox(sandbox, path);
    if (probe.outcome === 'pass') {
      return { file: path, outcome: 'pass' };
    }
    if (probe.outcome === 'not_evaluable') {
      errors.push(probe.detail || `Could not inspect ${path}`);
    }
  }
  return errors.length > 0
    ? { file: null, outcome: 'not_evaluable', detail: errors.join('; ') }
    : { file: null, outcome: 'fail' };
}

export async function findPageFile(
  sandbox: Sandbox,
  route: string,
): Promise<FileProbeResult> {
  const clean = route
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? `[${segment.slice(1)}]` : segment,
    )
    .join('/');
  return findRouteFile(
    sandbox,
    clean ? `src/app/${clean}/page` : 'src/app/page',
    ['tsx', 'jsx', 'ts', 'js'],
  );
}

export async function findApiFile(
  sandbox: Sandbox,
  route: string,
): Promise<FileProbeResult> {
  const clean = route
    .replace(/^\/api\//, '')
    .replace(/\/$/, '')
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? `[${segment.slice(1)}]` : segment,
    )
    .join('/');
  if (!clean) return { file: null, outcome: 'fail' };
  return findRouteFile(
    sandbox,
    `src/app/api/${clean}/route`,
    ['ts', 'js'],
  );
}

export async function apiFileDeclaresHandlers(
  sandbox: Sandbox,
  relFile: string,
  handlers: string[],
): Promise<{
  handlers: Record<string, boolean>;
  outcome: CoverageProbeOutcome;
  detail?: string;
}> {
  const values: Record<string, boolean> = Object.fromEntries(
    handlers.map((handler) => [handler, false]),
  );
  try {
    const result = await sandbox.runCommand({
      cmd: 'cat',
      args: [`${SandboxService.WORK_DIR}/${relFile}`],
    });
    if (result.exitCode !== 0) {
      return {
        handlers: values,
        outcome: 'not_evaluable',
        detail: `Could not read ${relFile}`,
      };
    }
    const source = (await result.stdout()).toString();
    for (const handler of handlers) {
      const pattern = new RegExp(
        `export\\s+(async\\s+)?function\\s+${handler}\\b|` +
        `export\\s+(const|let|var)\\s+${handler}\\b|` +
        `export\\s*\\{[^}]*\\b${handler}\\b`,
      );
      values[handler] = pattern.test(source);
    }
    return { handlers: values, outcome: 'pass' };
  } catch (error: unknown) {
    return {
      handlers: values,
      outcome: 'not_evaluable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
