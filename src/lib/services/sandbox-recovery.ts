import { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { verifyPlatformGitLayout } from '@/lib/services/sandbox-git-layout';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';

async function tryGetSandbox(sandboxId: string): Promise<Sandbox | null> {
  try {
    return await Sandbox.get({ sandboxId });
  } catch {
    return null;
  }
}

/** True if the microVM responds, git is installed, and the repo layout matches platform rules (root = WORK_DIR, not nested under app/). */
export async function pingSandboxWorkspace(sandbox: Sandbox): Promise<boolean> {
  try {
    const v = await verifyPlatformGitLayout(sandbox);
    if (!v.ok) {
      console.warn(`[Sandbox] ping failed layout check: ${v.reason}`);
    }
    return v.ok;
  } catch {
    return false;
  }
}

/**
 * Reconnects to an existing sandbox or creates a new VM, clones the repo, checks out the
 * requirement branch, and resets to the latest remote commit so the agent matches origin.
 */
export async function connectOrRecreateRequirementSandbox(params: {
  sandboxId: string;
  requirementId: string;
  instanceType: string;
  title: string;
  audit?: CronAuditContext;
}): Promise<{
  sandbox: Sandbox;
  sandboxId: string;
  recovered: boolean;
  branchName: string;
}> {
  const { sandboxId, requirementId, instanceType, title, audit } = params;

  let sandbox = await tryGetSandbox(sandboxId);
  if (sandbox && (await pingSandboxWorkspace(sandbox))) {
    const branchName = await SandboxService.getCurrentBranch(sandbox);
    return { sandbox, sandboxId, recovered: false, branchName };
  }

  console.warn(
    `[Sandbox] Sandbox unreachable (id=${sandboxId}) — reprovisioning VM and syncing to origin`,
  );
  const created = await SandboxService.createRequirementSandbox(requirementId, instanceType, title, audit);
  const auditCtx: CronAuditContext | undefined = audit?.siteId
    ? { ...audit, requirementId: audit.requirementId ?? requirementId }
    : undefined;
  await logCronInfrastructureEvent(auditCtx, {
    event: CronInfraEvent.SANDBOX_REPROVISIONED,
    message: `Sandbox reprovisioned after VM loss; branch ${created.branchName}`,
    details: {
      requirementId,
      previousSandboxId: sandboxId,
      newSandboxId: created.sandbox.sandboxId,
      branchName: created.branchName,
    },
  });

  return {
    sandbox: created.sandbox,
    sandboxId: created.sandbox.sandboxId,
    recovered: true,
    branchName: created.branchName,
  };
}
