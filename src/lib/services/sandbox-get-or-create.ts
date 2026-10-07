import { Sandbox } from '@vercel/sandbox';
import { buildSandboxCreateParams } from '@/lib/services/sandbox-create-params';
import { cloneRepoIntoWorkDir } from '@/lib/services/sandbox-git-clone';
import { sandboxSdkMajor } from '@/lib/services/sandbox-sdk';
import { resumeRequirementWorkspace } from '@/lib/services/sandbox-on-resume';
import { assertPlatformGitLayout } from '@/lib/services/sandbox-git-layout';
import { isMissingSandboxSnapshotError, isSandboxNotFoundError, retireSandboxWithoutSnapshots } from '@/lib/services/sandbox-missing-snapshot';
import { logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';

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
  requirementId?: string;
  assertRecoveryOwnership?: () => Promise<void>;
  audit?: CronAuditContext;
}): Promise<GetOrCreateResult | null> {
  if (sandboxSdkMajor() < 3) return null;
  let created = false;
  let workspaceCallbackStarted = false;
  const options = {
      ...buildSandboxCreateParams({
        name: params.name,
        tags: params.tags,
        persistent: true,
        coldCreate: true,
      }),
      onCreate: async (sbx: Sandbox) => {
        workspaceCallbackStarted = true;
        created = true;
        await cloneRepoIntoWorkDir(sbx, params.authRepoUrl);
        await assertPlatformGitLayout(sbx);
      },
      onResume: async (sbx: Sandbox) => {
        workspaceCallbackStarted = true;
        try {
          await resumeRequirementWorkspace(sbx, undefined, {
            authRepoUrl: params.authRepoUrl,
            requirementId: params.requirementId,
            syncToOrigin: false,
          });
        } catch (e: unknown) {
          console.warn(
            '[Sandbox] onResume failed (keeping existing VM):',
            e instanceof Error ? e.message : e,
          );
        }
      },
    };
  const getOrCreate = async (): Promise<Sandbox> => {
    // Do not use SDK getOrCreate: it silently deletes on 410 before our guards.
    let existing: Sandbox;
    try {
      existing = await Sandbox.get({ name: params.name, resume: true });
    } catch (error) {
      if (!isSandboxNotFoundError(error)) throw error;
      const sandbox = await Sandbox.create(options);
      await options.onCreate(sandbox);
      return sandbox;
    }
    await options.onResume(existing);
    return existing;
  };
  try {
    const sandbox = await getOrCreate();
    return { sandbox, created };
  } catch (error: unknown) {
    // All other failures propagate, never fork/create with a taken name.
    if (workspaceCallbackStarted || !params.assertRecoveryOwnership ||
      !isMissingSandboxSnapshotError(error)) throw error;
    await retireSandboxWithoutSnapshots(params.name, params.assertRecoveryOwnership);
    await logCronInfrastructureEvent(params.audit, {
      event: 'cron_infra_missing_snapshot_shell_retired',
      level: 'warn',
      message: `Retired stopped sandbox shell ${params.name} with no snapshots; rebuilding from Git/spec, not recovering lost workspace bytes`,
      details: { sandboxId: params.name, workspaceRecovered: false },
    });
    await params.assertRecoveryOwnership();
    const sandbox = await getOrCreate();
    return { sandbox, created };
  }
}
