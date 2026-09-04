import type { Sandbox } from '@vercel/sandbox';
import { NPM_LOCK_HASH_MARKER, SANDBOX_WORK_DIR } from '@/lib/services/sandbox-constants';

export type EnsureNpmDepsResult = {
  skipped: boolean;
  usedCi: boolean;
  reason: string;
};

export function interpretNpmProbeOutput(out: string): 'skip' | 'ci' | 'install' {
  const t = (out || '').trim();
  if (t.startsWith('SKIP')) return 'skip';
  if (t.startsWith('NO_LOCK')) return 'install';
  return 'ci';
}

/**
 * Install workspace deps only when package-lock.json changed (or node_modules is missing).
 * Cold start prefers `npm ci` when a lockfile exists.
 */
export async function ensureNpmDeps(
  sandbox: Sandbox,
  cwd: string = SANDBOX_WORK_DIR,
  opts?: { preferOffline?: boolean },
): Promise<EnsureNpmDepsResult> {
  const preferOffline = opts?.preferOffline ?? false;
  const probe = await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `
cd "${cwd}" || exit 1
LOCK=""
if [ -f package-lock.json ]; then LOCK=package-lock.json
elif [ -f npm-shrinkwrap.json ]; then LOCK=npm-shrinkwrap.json
fi
if [ -z "$LOCK" ]; then
  echo "NO_LOCK"
  exit 0
fi
HASH=$(sha256sum "$LOCK" 2>/dev/null | awk '{print $1}')
PREV=""
if [ -f "${NPM_LOCK_HASH_MARKER}" ]; then PREV=$(cat "${NPM_LOCK_HASH_MARKER}"); fi
if [ -d node_modules ] && [ -n "$HASH" ] && [ "$HASH" = "$PREV" ]; then
  echo "SKIP $HASH"
  exit 0
fi
echo "INSTALL $HASH $LOCK"
`,
    ],
  });
  const out = ((await probe.stdout()) || '').trim();
  const decision = interpretNpmProbeOutput(out);
  if (decision === 'skip') {
    console.log('[Sandbox] npm deps unchanged — skipping install');
    return { skipped: true, usedCi: false, reason: 'lockfile-hash-match' };
  }

  const usedCi = decision === 'ci';
  const args = usedCi
    ? ['ci', '--no-audit', '--no-fund']
    : ['install', '--no-audit', '--no-fund'];
  if (preferOffline && !usedCi) args.splice(1, 0, '--prefer-offline');

  const install = await sandbox.runCommand({ cmd: 'npm', args, cwd });
  if (install.exitCode !== 0) {
    const err = await install.stderr();
    if (usedCi) {
      console.warn('[Sandbox] npm ci failed, falling back to npm install:', err.slice(0, 400));
      const fb = await sandbox.runCommand({
        cmd: 'npm',
        args: preferOffline
          ? ['install', '--prefer-offline', '--no-audit', '--no-fund']
          : ['install', '--no-audit', '--no-fund'],
        cwd,
      });
      if (fb.exitCode !== 0) {
        throw new Error(`npm install failed: ${await fb.stderr()}`);
      }
    } else {
      throw new Error(`npm install failed: ${err}`);
    }
  }

  await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `cd "${cwd}" && LOCK=package-lock.json; [ -f "$LOCK" ] || LOCK=npm-shrinkwrap.json; [ -f "$LOCK" ] && sha256sum "$LOCK" | awk '{print $1}' > "${NPM_LOCK_HASH_MARKER}" || true`,
    ],
  });

  return { skipped: false, usedCi, reason: usedCi ? 'npm-ci' : 'npm-install' };
}
