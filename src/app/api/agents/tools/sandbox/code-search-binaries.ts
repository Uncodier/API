import type { Sandbox } from '@vercel/sandbox';

export const RG_BIN = '/tmp/agent-bin/rg';
export const SG_BIN = '/tmp/agent-bin/sg';

const BIN_DIR = '/tmp/agent-bin';
const RG_VERSION = '14.1.1';

export interface EnsureSearchBinariesResult {
  rg: boolean;
  sg: boolean;
  install_log?: string;
}

const ensureCache = new WeakMap<
  Sandbox,
  Promise<EnsureSearchBinariesResult>
>();

async function shell(
  sandbox: Sandbox,
  script: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', script],
  });
  return {
    stdout: await result.stdout(),
    stderr: await result.stderr(),
    exitCode: result.exitCode,
  };
}

async function linkBinary(
  sandbox: Sandbox,
  source: string,
  destination: string,
): Promise<boolean> {
  if (source === destination) return true;
  const result = await sandbox.runCommand({
    cmd: 'ln',
    args: ['-sf', source, destination],
  });
  return result.exitCode === 0;
}

export async function ensureSearchBinaries(
  sandbox: Sandbox,
): Promise<EnsureSearchBinariesResult> {
  const cached = ensureCache.get(sandbox);
  if (cached) return cached;

  const job = (async (): Promise<EnsureSearchBinariesResult> => {
    const installLog: string[] = [];
    await sandbox.runCommand({ cmd: 'mkdir', args: ['-p', BIN_DIR] });

    const rgProbe = await shell(
      sandbox,
      `[ -x "${RG_BIN}" ] && echo "${RG_BIN}" || command -v rg || true`,
    );
    const discoveredRg = rgProbe.stdout.trim().split(/\s+/)[0];
    let rg = discoveredRg
      ? await linkBinary(sandbox, discoveredRg, RG_BIN)
      : false;
    if (!rg) {
      const archive =
        `ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl`;
      const install = await shell(
        sandbox,
        [
          'set -e',
          'cd /tmp',
          `curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${archive}.tar.gz" -o rg.tar.gz`,
          'tar -xzf rg.tar.gz',
          `cp ${archive}/rg ${RG_BIN}`,
          `chmod +x ${RG_BIN}`,
          `rm -rf rg.tar.gz ${archive}`,
        ].join(' && '),
      );
      rg = install.exitCode === 0;
      if (!rg) {
        installLog.push(
          `rg install failed: ${install.stderr.trim() || install.stdout.trim()}`,
        );
      }
    }

    const sgProbe = await shell(
      sandbox,
      `[ -x "${SG_BIN}" ] && echo "${SG_BIN}" || command -v sg || command -v ast-grep || true`,
    );
    const discoveredSg = sgProbe.stdout.trim().split(/\s+/)[0];
    let sg = discoveredSg
      ? await linkBinary(sandbox, discoveredSg, SG_BIN)
      : false;
    if (!sg) {
      const install = await shell(
        sandbox,
        'npm install -g @ast-grep/cli >/tmp/sg-install.log 2>&1',
      );
      const installedProbe = install.exitCode === 0
        ? await shell(sandbox, 'command -v sg || command -v ast-grep || true')
        : { stdout: '', stderr: install.stderr, exitCode: install.exitCode };
      const installedSg = installedProbe.stdout.trim().split(/\s+/)[0];
      sg = installedSg
        ? await linkBinary(sandbox, installedSg, SG_BIN)
        : false;
      if (!sg) {
        const log = await shell(
          sandbox,
          'tail -c 4000 /tmp/sg-install.log 2>/dev/null || true',
        );
        installLog.push(
          `sg install failed: ${log.stdout.trim() || install.stderr.trim()}`,
        );
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
