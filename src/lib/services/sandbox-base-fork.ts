import { Sandbox } from '@vercel/sandbox';
import { requirementSandboxName, sandboxBaseName } from '@/lib/services/sandbox-constants';
import { sandboxSdkMajor } from '@/lib/services/sandbox-sdk';
import { buildSandboxCreateParams, requirementSandboxTags } from '@/lib/services/sandbox-create-params';
import { resolveDefaultGitBinding } from '@/lib/services/requirement-git-binding';
import { cloneRepoIntoWorkDir } from '@/lib/services/sandbox-git-clone';
import { ensureNpmDeps } from '@/lib/services/sandbox-npm';

/**
 * Ensure the shared base image exists (template + node_modules + sg), then
 * fork it for a requirement. Returns null on v1 or if fork is unavailable.
 */
export async function tryForkFromBase(params: {
  requirementId: string;
  instanceId?: string | null;
  instanceType: string;
}): Promise<Sandbox | null> {
  if (sandboxSdkMajor() < 3) return null;
  const forkFn = (Sandbox as unknown as {
    fork?: (opts: Record<string, unknown>) => Promise<Sandbox>;
  }).fork;
  if (typeof forkFn !== 'function') return null;

  const kind = params.instanceType === 'automation' ? 'automation' : 'applications';
  await ensureBaseSandbox(kind);

  try {
    return await forkFn({
      sourceSandbox: sandboxBaseName(kind),
      name: requirementSandboxName(params.requirementId, params.instanceId),
      ...buildSandboxCreateParams({
        name: requirementSandboxName(params.requirementId, params.instanceId),
        tags: requirementSandboxTags(params.requirementId, params.instanceId),
      }),
    });
  } catch (e: unknown) {
    console.warn(
      '[Sandbox] fork from base failed (will clone):',
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

export async function ensureBaseSandbox(kind: 'applications' | 'automation'): Promise<void> {
  const getOrCreate = (Sandbox as unknown as {
    getOrCreate?: (opts: Record<string, unknown>) => Promise<Sandbox>;
  }).getOrCreate;
  if (typeof getOrCreate !== 'function') return;

  const binding = resolveDefaultGitBinding(kind === 'automation' ? 'automation' : 'applications');
  const token = process.env.GITHUB_TOKEN?.trim() || '';
  const authRepoUrl = token
    ? `https://x-access-token:${token}@github.com/${binding.org}/${binding.repo}.git`
    : `https://github.com/${binding.org}/${binding.repo}.git`;

  try {
    await getOrCreate({
      ...buildSandboxCreateParams({
        name: sandboxBaseName(kind),
        tags: { kind: 'base', repo: kind },
        persistent: true,
        coldCreate: true,
      }),
      resume: true,
      onCreate: async (sbx: Sandbox) => {
        await cloneRepoIntoWorkDir(sbx, authRepoUrl);
        await ensureNpmDeps(sbx);
        await sbx.runCommand({
          cmd: 'sh',
          args: ['-c', 'command -v sg >/dev/null 2>&1 || npm install -g @ast-grep/cli'],
        });
      },
    });
  } catch (e: unknown) {
    console.warn(
      '[Sandbox] ensureBaseSandbox failed (fork will no-op):',
      e instanceof Error ? e.message : e,
    );
  }
}
