import { Sandbox } from '@vercel/sandbox';
import { buildSandboxCreateParams } from '@/lib/services/sandbox-create-params';
import { cloneRepoIntoWorkDir } from '@/lib/services/sandbox-git-clone';
import { sandboxSdkMajor } from '@/lib/services/sandbox-sdk';
import { resumeRequirementWorkspace } from '@/lib/services/sandbox-on-resume';
import { assertPlatformGitLayout } from '@/lib/services/sandbox-git-layout';

export type GetOrCreateResult = {
  sandbox: Sandbox;
  created: boolean;
};

/**
 * Named persistent sandbox. Clones into /vercel/sandbox on first create
 * (does not use source.git — v3 would nest the repo). On resume, fetch +
 * skip npm when the lockfile hash matches.
 */
export async function getOrCreateRequirementSandbox(params: {
  name: string;
  tags: Record<string, string>;
  authRepoUrl: string;
}): Promise<GetOrCreateResult | null> {
  if (sandboxSdkMajor() < 3) return null;
  const getOrCreate = (Sandbox as unknown as {
    getOrCreate?: (opts: Record<string, unknown>) => Promise<Sandbox>;
  }).getOrCreate;
  if (typeof getOrCreate !== 'function') return null;

  let created = false;
  try {
    const sandbox = await getOrCreate({
      ...buildSandboxCreateParams({
        name: params.name,
        tags: params.tags,
        persistent: true,
        coldCreate: true,
      }),
      resume: true,
      onCreate: async (sbx: Sandbox) => {
        created = true;
        await cloneRepoIntoWorkDir(sbx, params.authRepoUrl);
        await assertPlatformGitLayout(sbx);
      },
      onResume: async (sbx: Sandbox) => {
        try {
          await resumeRequirementWorkspace(sbx, undefined, { authRepoUrl: params.authRepoUrl });
        } catch (e: unknown) {
          console.warn(
            '[Sandbox] onResume failed (keeping existing VM):',
            e instanceof Error ? e.message : e,
          );
        }
      },
    });
    return { sandbox, created };
  } catch (e: unknown) {
    console.warn(
      '[Sandbox] getOrCreate failed, falling back to create:',
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
