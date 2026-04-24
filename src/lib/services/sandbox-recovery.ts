import { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { verifyPlatformGitLayout } from '@/lib/services/sandbox-git-layout';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';

const GET_SANDBOX_ATTEMPTS = 5;

async function tryGetSandbox(sandboxId: string): Promise<Sandbox | null> {
  let delayMs = 1000;
  for (let attempt = 0; attempt < GET_SANDBOX_ATTEMPTS; attempt++) {
    try {
      return await Sandbox.get({ sandboxId });
    } catch (e: unknown) {
      if (attempt < GET_SANDBOX_ATTEMPTS - 1) {
        console.warn(`[Sandbox] tryGetSandbox attempt ${attempt + 1} failed for ${sandboxId}. Retrying in ${delayMs}ms...`);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2; // Exponential backoff: 1s, 2s, 4s, 8s
      } else {
        console.error(`[Sandbox] tryGetSandbox failed after ${GET_SANDBOX_ATTEMPTS} attempts for ${sandboxId}.`);
      }
    }
  }
  return null;
}

/** Reattach to an existing VM without provisioning a replacement (use right after create). */
export async function getSandboxWithRetriesOrThrow(sandboxId: string): Promise<Sandbox> {
  const s = await tryGetSandbox(sandboxId);
  if (!s) {
    throw new Error(`Sandbox.get failed after ${GET_SANDBOX_ATTEMPTS} attempts (${sandboxId})`);
  }
  return s;
}

/**
 * Best-effort stop by id (handles flaky `get` on first try: a second get may
 * still attach to a Running VM that would otherwise be orphaned when we
 * `Sandbox.create` a replacement).
 */
async function stopSandboxByIdQuiet(sandboxId: string): Promise<void> {
  const s = await tryGetSandbox(sandboxId);
  if (!s) return;
  
  let delayMs = 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await s.stop({ blocking: false });
      return;
    } catch (e: unknown) {
      if (attempt < 2) {
        console.warn(`[Sandbox] stopSandboxByIdQuiet attempt ${attempt + 1} failed for ${sandboxId}. Retrying in ${delayMs}ms...`);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      } else {
        console.error(`[Sandbox] Failed to stop sandbox ${sandboxId} after 3 attempts. It may be orphaned.`);
      }
    }
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

  if (sandbox) {
    // Layout ping failed — stop this VM before creating another, otherwise
    // every connectOrRecreate leaves a billing zombie (dashboard full of Running).
    let delayMs = 1000;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sandbox.stop();
        console.log(`[Sandbox] Stopped sandbox after failed layout ping, before reprovision (${sandboxId})`);
        break;
      } catch (e: unknown) {
        if (attempt < 2) {
          console.warn(`[Sandbox] stop() before reprovision attempt ${attempt + 1} failed (${sandboxId}). Retrying in ${delayMs}ms...`);
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
        } else {
          console.error(`[Sandbox] stop() before reprovision failed after 3 attempts (${sandboxId}):`, e instanceof Error ? e.message : e);
        }
      }
    }
  } else {
    console.warn(
      `[Sandbox] Sandbox.get failed for id=${sandboxId} after retries — will stop by id if still reachable, then reprovision`,
    );
  }

  console.warn(
    `[Sandbox] Reprovisioning VM and syncing to origin (replaced id=${sandboxId})`,
  );
  await stopSandboxByIdQuiet(sandboxId);
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
