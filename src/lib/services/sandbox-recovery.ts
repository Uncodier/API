import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { persistActiveSandboxId } from '@/lib/tools/requirement-status-core';
import { getSandboxHandle, sandboxIdentity } from '@/lib/services/sandbox-sdk';
import { deleteRequirementSandboxes } from '@/lib/services/sandbox-lifecycle';
import { warmStartNamedSandbox } from '@/lib/services/sandbox-on-resume';
import { isFatalGitLayoutReason, verifyPlatformGitLayout } from '@/lib/services/sandbox-git-layout';
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
      return await getSandboxHandle(sandboxId);
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

export type SandboxPing = { ok: boolean; reason?: string; fatal: boolean };

/** True if the microVM responds and the repo layout matches platform rules. */
export async function inspectSandboxWorkspace(sandbox: Sandbox): Promise<SandboxPing> {
  try {
    const v = await verifyPlatformGitLayout(sandbox);
    if (v.ok) return { ok: true, fatal: false };
    console.warn(`[Sandbox] ping failed layout check: ${v.reason}`);
    return { ok: false, reason: v.reason, fatal: isFatalGitLayoutReason(v.reason) };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, reason, fatal: false };
  }
}

export async function pingSandboxWorkspace(sandbox: Sandbox): Promise<boolean> {
  return (await inspectSandboxWorkspace(sandbox)).ok;
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
  if (sandbox) {
    const ping = await inspectSandboxWorkspace(sandbox);
    if (!ping.fatal) {
      await warmStartNamedSandbox(sandbox, requirementId, instanceType, { syncToOrigin: false }).catch((e) => {
        console.warn('[Sandbox] connect warm-start skipped:', e instanceof Error ? e.message : e);
      });
      const branchName = await SandboxService.getCurrentBranch(sandbox);
      return { sandbox, sandboxId, recovered: false, branchName };
    }
    console.warn(`[Sandbox] Fatal nested layout on ${sandboxId}: ${ping.reason}`);
  }

  // If the provided sandboxId failed, check if the DB has a newer active_sandbox_id
  if (audit?.instanceId) {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const { data: reqStatus } = await supabaseAdmin
      .from('requirement_status')
      .select('active_sandbox_id')
      .eq('requirement_id', requirementId)
      .eq('instance_id', audit.instanceId)
      .not('active_sandbox_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (reqStatus?.active_sandbox_id && reqStatus.active_sandbox_id !== sandboxId) {
      console.warn(`[Sandbox] Provided sandboxId ${sandboxId} failed, but DB has newer active_sandbox_id ${reqStatus.active_sandbox_id}. Trying that...`);
      const dbSandbox = await tryGetSandbox(reqStatus.active_sandbox_id);
      if (dbSandbox) {
        const dbPing = await inspectSandboxWorkspace(dbSandbox);
        if (!dbPing.fatal) {
          await warmStartNamedSandbox(dbSandbox, requirementId, instanceType, { syncToOrigin: false }).catch((e) => {
            console.warn('[Sandbox] connect warm-start skipped:', e instanceof Error ? e.message : e);
          });
          const branchName = await SandboxService.getCurrentBranch(dbSandbox);
          return { sandbox: dbSandbox, sandboxId: reqStatus.active_sandbox_id, recovered: true, branchName };
        }
      }
    }
  }

  if (sandbox) {
    console.warn(
      `[Sandbox] Deleting ${sandboxId} after fatal layout (nested app/) before reprovision`,
    );
    await deleteRequirementSandboxes(requirementId, audit?.instanceId, [sandboxId]);
  } else {
    console.warn(
      `[Sandbox] Sandbox.get failed for id=${sandboxId} — will getOrCreate by name (no delete)`,
    );
  }
  const created = await SandboxService.createRequirementSandbox(requirementId, instanceType, title, audit);

  if (audit?.instanceId) {
    await persistActiveSandboxId(requirementId, audit.instanceId, sandboxIdentity(created.sandbox), audit.siteId)
      .catch(e => console.error(`[Sandbox] Failed to update active_sandbox_id to ${sandboxIdentity(created.sandbox)}:`, e));
  }

  const auditCtx: CronAuditContext | undefined = audit?.siteId
    ? { ...audit, requirementId: audit.requirementId ?? requirementId }
    : undefined;
  await logCronInfrastructureEvent(auditCtx, {
    event: CronInfraEvent.SANDBOX_REPROVISIONED,
    message: `Sandbox reprovisioned after VM loss; branch ${created.branchName}`,
    details: {
      requirementId,
      previousSandboxId: sandboxId,
      newSandboxId: sandboxIdentity(created.sandbox),
      branchName: created.branchName,
    },
  });

  return {
    sandbox: created.sandbox,
    sandboxId: sandboxIdentity(created.sandbox),
    recovered: true,
    branchName: created.branchName,
  };
}
