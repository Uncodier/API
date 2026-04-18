import type { Sandbox } from '@vercel/sandbox';

const REPO_ROOT = '/vercel/sandbox';

export type VercelNpmRepoKind = 'applications' | 'automation';

async function readSandboxTextFile(sandbox: Sandbox, rel: string): Promise<string | null> {
  const r = await sandbox.runCommand('sh', ['-c', `cat "${REPO_ROOT}/${rel}" 2>/dev/null || true`]);
  const out = (await r.stdout()).trim();
  return out.length > 0 ? out : null;
}

/**
 * Ensures the repo matches what Vercel expects for `npm ci` + Next.js on the apps project.
 * Blocks stub-only package.json / missing lockfile that pass a no-op local `npm run build` but fail on Vercel.
 */
export async function validateNpmRepoForVercelDeploy(
  sandbox: Sandbox,
  kind: VercelNpmRepoKind,
): Promise<string | null> {
  const pkgRaw = await readSandboxTextFile(sandbox, 'package.json');
  if (pkgRaw == null) {
    return `Missing package.json at ${REPO_ROOT}.`;
  }

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    return 'package.json is not valid JSON.';
  }

  const lockRaw = await readSandboxTextFile(sandbox, 'package-lock.json');
  if (lockRaw == null) {
    return (
      'Missing package-lock.json — Vercel runs `npm ci || npm install` and requires a lockfile. ' +
      `Run \`cd ${REPO_ROOT} && npm install\`, then commit package-lock.json.`
    );
  }

  try {
    const lock = JSON.parse(lockRaw) as { lockfileVersion?: unknown };
    if (typeof lock.lockfileVersion !== 'number') {
      return 'package-lock.json must contain lockfileVersion (regenerate with npm install at repo root).';
    }
  } catch {
    return 'package-lock.json is not valid JSON.';
  }

  if (kind === 'applications') {
    const next = pkg.dependencies?.next ?? pkg.devDependencies?.next;
    if (typeof next !== 'string' || !next.trim()) {
      return (
        'For makinary/apps, package.json must list "next" in dependencies or devDependencies. ' +
        'A stub package.json without Next.js will fail on Vercel with "No Next.js version detected".'
      );
    }
  }

  return null;
}
