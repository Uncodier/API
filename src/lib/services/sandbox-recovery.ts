import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { persistActiveSandboxId } from '@/lib/tools/requirement-status-core';
import { getSandboxHandle, sandboxIdentity } from '@/lib/services/sandbox-sdk';
import { deleteRequirementSandboxes } from '@/lib/services/sandbox-lifecycle';
import { warmStartNamedSandbox } from '@/lib/services/sandbox-on-resume';
import { inspectFastAttachWorkspace, runningSessionId } from './sandbox-fast-attach';
import { branchBelongsToRequirement } from './requirement-branch';
import { isFatalGitLayoutReason, verifyPlatformGitLayout } from '@/lib/services/sandbox-git-layout';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';

const GET_SANDBOX_ATTEMPTS = 5;

async function tryGetSandbox(sandboxId: string, fastAttach = false): Promise<{
  sandbox: Sandbox;
  fastSessionId: string | null;
} | null> {
  let delayMs = 1000;
  for (let attempt = 0; attempt < GET_SANDBOX_ATTEMPTS; attempt++) {
    try {
      const sandbox = await getSandboxHandle(sandboxId);
      const fastSessionId = fastAttach ? runningSessionId(sandbox) : null;
      
      // Explicitly resume the sandbox bypassing runCommand's "use step" wrapper.
      // This avoids a 3-retry loop in the Vercel Workflows engine when the sandbox is dead (410).
      if (!fastSessionId && typeof (sandbox as any).resume === 'function') {
        try {
          await (sandbox as any).resume();
        } catch (resumeErr: any) {
          if (resumeErr?.response?.status === 410 || String(resumeErr?.message).includes('410')) {
            console.warn(`[Sandbox] Not reusing ${sandboxId}: sandbox dead (410)`);
            return null; // Don't retry getting a dead sandbox
          }
          throw resumeErr; // Throw to trigger the getSandboxHandle retry loop
        }
      }
      
      return { sandbox, fastSessionId };
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
  return s.sandbox;
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
  /** Mid-cycle only: read-only attach if this exact running session is healthy.
   * Callers must independently recheck execution ownership before every turn/tool.
   * Defaults to the existing warm recovery path; never skips genuine resume.
   */
  fastAttach?: boolean;
}): Promise<{
  sandbox: Sandbox;
  sandboxId: string;
  recovered: boolean;
  branchName: string;
}> {
  const { sandboxId, requirementId, instanceType, title, audit } = params;

  const connected = await tryGetSandbox(sandboxId, params.fastAttach);
  const sandbox = connected?.sandbox;
  if (sandbox) {
    if (connected.fastSessionId) {
      const branchName = await inspectFastAttachWorkspace(sandbox, requirementId, connected.fastSessionId);
      if (branchName) return { sandbox, sandboxId, recovered: false, branchName };
    }
    const ping = await inspectSandboxWorkspace(sandbox);
    if (!ping.fatal) {
      await warmStartNamedSandbox(sandbox, requirementId, instanceType, {
        syncToOrigin: false,
      });
      // A transient pre-resume ping must not be treated as proof of a valid root.
      const afterWarm = await inspectSandboxWorkspace(sandbox);
      if (!afterWarm.ok) throw new Error(`Sandbox workspace not ready after warm recovery: ${afterWarm.reason}`);
      let branchName: string | undefined;
      try {
        branchName = await SandboxService.getCurrentBranch(sandbox);
      } catch (e: unknown) {
        console.warn(`[Sandbox] connect failed to get branch, forcing reprovision:`, e instanceof Error ? e.message : e);
      }
      if (branchName !== undefined) {
        if (params.fastAttach && !branchBelongsToRequirement(branchName, requirementId)) {
          // Do not delete a live workspace (and possible unpushed edits) on a
          // branch mismatch. Surface the problem instead of silently attaching.
          throw new Error('Warm recovery did not attach the expected requirement branch');
        }
        return { sandbox, sandboxId, recovered: false, branchName };
      }
    } else {
      console.warn(`[Sandbox] Fatal nested layout on ${sandboxId}: ${ping.reason}`);
    }
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
      const dbSandbox = (await tryGetSandbox(reqStatus.active_sandbox_id))?.sandbox;
      if (dbSandbox) {
        const dbPing = await inspectSandboxWorkspace(dbSandbox);
        if (!dbPing.fatal) {
          await warmStartNamedSandbox(dbSandbox, requirementId, instanceType, {
            syncToOrigin: false,
          });
          const afterWarm = await inspectSandboxWorkspace(dbSandbox);
          if (!afterWarm.ok) throw new Error(`Sandbox workspace not ready after warm recovery: ${afterWarm.reason}`);
          let branchName: string | undefined;
          try {
            branchName = await SandboxService.getCurrentBranch(dbSandbox);
          } catch (e: unknown) {
            console.warn(`[Sandbox] DB active sandbox failed to get branch, forcing reprovision:`, e instanceof Error ? e.message : e);
          }
          if (branchName !== undefined) {
            if (params.fastAttach && !branchBelongsToRequirement(branchName, requirementId)) {
              throw new Error('Warm recovery did not attach the expected requirement branch');
            }
            return { sandbox: dbSandbox, sandboxId: reqStatus.active_sandbox_id, recovered: true, branchName };
          }
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
