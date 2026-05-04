import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { assertPlatformGitLayout } from '@/lib/services/sandbox-git-layout';
import { branchBelongsToRequirement } from '@/lib/services/requirement-branch';
import type { GitBinding } from '@/lib/services/requirement-git-binding';
import { persistedSnapshotMatchesBinding } from '@/lib/services/sandbox-persisted-snapshot-policy';
import type { SandboxResult } from '@/lib/services/sandbox-service';
import { SandboxService } from '@/lib/services/sandbox-service';
import { persistActiveSandboxId } from '@/lib/tools/requirement-status-core';

export { persistedSnapshotMatchesBinding } from '@/lib/services/sandbox-persisted-snapshot-policy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SANDBOX_CREATE_TIMEOUT_MS = 15 * 60 * 1000;
const EXTEND_AFTER_CREATE_MS = 10 * 60 * 1000;

export type PersistedSnapshotRow = {
  snapshot_id: string;
  repo_url: string | null;
};

export async function fetchLatestRequirementSnapshotRow(
  requirementId: string,
  instanceId?: string | null,
): Promise<PersistedSnapshotRow | null> {
  const validInstance = instanceId && UUID_RE.test(instanceId) ? instanceId : null;
  if (validInstance) {
    const { data } = await supabaseAdmin
      .from('requirement_status')
      .select('snapshot_id, repo_url')
      .eq('requirement_id', requirementId)
      .eq('instance_id', validInstance)
      .not('snapshot_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.snapshot_id?.trim()) {
      return { snapshot_id: data.snapshot_id.trim(), repo_url: data.repo_url ?? null };
    }
  }
  const { data: anyRow } = await supabaseAdmin
    .from('requirement_status')
    .select('snapshot_id, repo_url')
    .eq('requirement_id', requirementId)
    .not('snapshot_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!anyRow?.snapshot_id?.trim()) return null;
  return { snapshot_id: anyRow.snapshot_id.trim(), repo_url: anyRow.repo_url ?? null };
}

async function installGitIdentity(sandbox: Sandbox, authRepoUrl: string): Promise<void> {
  const workDir = SandboxService.WORK_DIR;
  await sandbox.runCommand({
    cmd: 'git',
    args: ['config', '--global', 'user.name', process.env.GIT_AUTHOR_NAME || 'Assistant Runner'],
  });
  await sandbox.runCommand({
    cmd: 'git',
    args: ['config', '--global', 'user.email', process.env.GIT_AUTHOR_EMAIL || 'assistant@uncodie.com'],
  });
  const setRemote = await sandbox.runCommand({
    cmd: 'git',
    args: ['remote', 'set-url', 'origin', authRepoUrl],
    cwd: workDir,
  });
  if (setRemote.exitCode !== 0) {
    const addRemote = await sandbox.runCommand({
      cmd: 'git',
      args: ['remote', 'add', 'origin', authRepoUrl],
      cwd: workDir,
    });
    if (addRemote.exitCode !== 0) {
      throw new Error(`Failed to configure git remote after snapshot: ${await addRemote.stderr()}`);
    }
  }
}

async function stopSandboxQuiet(sandbox: Sandbox): Promise<void> {
  let delayMs = 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sandbox.stop({ blocking: false });
      return;
    } catch (e: unknown) {
      if (attempt < 2) {
        console.warn(`[Sandbox] 🧹 CLEANUP: stopSandboxQuiet attempt ${attempt + 1} failed for ${sandbox.sandboxId}. Retrying in ${delayMs}ms...`);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      } else {
        console.error(`[Sandbox] 🚨 ZOMBIE ALERT: Failed to stop sandbox ${sandbox.sandboxId} after 3 attempts. It may be orphaned.`);
      }
    }
  }
}

/**
 * Attempts to delete a snapshot from Vercel by ID.
 * Does not throw on failure to avoid breaking the main flow.
 */
export async function deleteSnapshotQuiet(snapshotId: string): Promise<void> {
  if (!snapshotId) return;
  
  try {
    const token = process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN;
    if (!token) {
      console.warn(`[Sandbox] 🧹 CLEANUP: Cannot delete snapshot ${snapshotId} because VERCEL_TOKEN is not set.`);
      return;
    }

    const res = await fetch(`https://api.vercel.com/v1/sandboxes/snapshots/${snapshotId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (res.ok) {
      console.log(`[Sandbox] 🧹 CLEANUP: Deleted old snapshot ${snapshotId}`);
    } else {
      console.warn(`[Sandbox] 🧹 CLEANUP: Failed to delete snapshot ${snapshotId}: ${res.status} ${await res.text()}`);
    }
  } catch (e: unknown) {
    console.error(`[Sandbox] 🧹 CLEANUP: Error deleting snapshot ${snapshotId}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Best-effort: create VM from DB snapshot, fetch, checkout branch, sync to origin, npm install.
 * Returns null when skipped or failed (caller falls back to git clone).
 */
export async function tryStartFromPersistedSnapshot(params: {
  requirementId: string;
  instanceType: string;
  title: string;
  binding: GitBinding;
  githubToken: string;
  auditCtx?: CronAuditContext;
}): Promise<SandboxResult | null> {
  const { requirementId, instanceType, title, binding, githubToken, auditCtx } = params;
  const row = await fetchLatestRequirementSnapshotRow(requirementId, auditCtx?.instanceId);
  if (!row) return null;
  if (!persistedSnapshotMatchesBinding(requirementId, binding, row.repo_url)) {
    console.warn('[Sandbox] snapshot bootstrap skipped: repo_url does not match git binding');
    return null;
  }

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create({
      runtime: 'node24',
      timeout: SANDBOX_CREATE_TIMEOUT_MS,
      source: { type: 'snapshot', snapshotId: row.snapshot_id },
    } as any); // We cast to any because the type definition for snapshot doesn't allow runtime or other fields
    
    if (auditCtx?.instanceId) {
      await persistActiveSandboxId(requirementId, auditCtx.instanceId, sandbox.sandboxId, auditCtx.siteId)
        .catch(e => console.error('[Sandbox] Failed to persist active_sandbox_id from snapshot:', e));
    }
  } catch (e: unknown) {
    console.warn(
      '[Sandbox] Sandbox.create(snapshot) failed, falling back to git:',
      e instanceof Error ? e.message : e,
    );
    return null;
  }

  try {
    try {
      await sandbox.extendTimeout(EXTEND_AFTER_CREATE_MS);
    } catch {
      /* may be at limit */
    }

    await logCronInfrastructureEvent(auditCtx, {
      event: CronInfraEvent.SANDBOX_VM_CREATED,
      message: 'Vercel Sandbox VM created from persisted snapshot',
      details: {
        requirementId,
        instanceType,
        snapshotId: row.snapshot_id,
      },
    });

    const authRepoUrl = `https://x-access-token:${githubToken}@github.com/${binding.org}/${binding.repo}.git`;
    await installGitIdentity(sandbox, authRepoUrl);

    const workDir = SandboxService.WORK_DIR;
    const fetchRes = await SandboxService.runCommandInSandbox(sandbox, 'git', ['fetch', '--all'], workDir);
    if (fetchRes.exitCode !== 0) {
      throw new Error(`fetch after snapshot VM failed: ${fetchRes.stderr}`);
    }

    const knownBranches = await SandboxService.getKnownBranches(requirementId);
    const candidates: string[] = [];
    const fromUrl = row.repo_url ? SandboxService.extractBranchFromRepoUrl(row.repo_url) : null;
    if (fromUrl && branchBelongsToRequirement(fromUrl, requirementId)) {
      candidates.push(fromUrl);
    }
    for (const b of knownBranches) {
      if (!candidates.includes(b)) candidates.push(b);
    }
    const canonical = SandboxService.buildBranchName(requirementId, title);
    if (!candidates.includes(canonical)) candidates.push(canonical);

    for (const branch of candidates) {
      const checkRes = await SandboxService.runCommandInSandbox(
        sandbox,
        'git',
        ['rev-parse', '--verify', `origin/${branch}`],
        workDir,
      );
      if (checkRes.exitCode !== 0) continue;

      const trackRes = await sandbox.runCommand({
        cmd: 'git',
        args: ['checkout', '--track', `origin/${branch}`],
        cwd: workDir,
      });
      if (trackRes.exitCode !== 0) {
        const fb = await sandbox.runCommand({
          cmd: 'git',
          args: ['checkout', '-B', branch, `origin/${branch}`],
          cwd: workDir,
        });
        if (fb.exitCode !== 0) {
          console.warn(`[Sandbox] checkout ${branch} after snapshot failed: ${await fb.stderr()}`);
          continue;
        }
      }
      await SandboxService.syncTrackedBranchToRemoteTip(sandbox, branch);
      await sandbox.runCommand({
        cmd: 'npm',
        args: ['install', '--prefer-offline', '--no-audit', '--no-fund'],
        cwd: workDir,
      });
      await assertPlatformGitLayout(sandbox);
      await logCronInfrastructureEvent(auditCtx, {
        event: CronInfraEvent.GIT_WORKSPACE_READY,
        message: `Git workspace ready (restored from snapshot, branch ${branch})`,
        details: {
          requirementId,
          branchName: branch,
          isNewBranch: false,
          workDir,
          repo: `${binding.org}/${binding.repo}`,
          git: 'source_snapshot_checkout_npm',
        },
      });
      return { sandbox, branchName: branch, workDir, isNewBranch: false, instanceType };
    }

    throw new Error('no origin branch matched after snapshot restore');
  } catch (e: unknown) {
    console.warn(
      '[Sandbox] snapshot bootstrap failed, discarding VM:',
      e instanceof Error ? e.message : e,
    );
    await stopSandboxQuiet(sandbox);
    return null;
  }
}

/**
 * SDK note: `sandbox.snapshot()` stops the source VM. We always recreate a new VM from the snapshot
 * so callers keep a live sandbox. On recreate failure, provisions a fresh git sandbox (skipSnapshotReuse).
 */
export async function snapshotAfterSuccessfulPushAndRecreate(params: {
  sandbox: Sandbox;
  branch: string;
  authRepoUrl: string;
  requirementId: string;
  instanceType: string;
  title: string;
  auditCtx?: CronAuditContext;
  isPushRecovery?: boolean;
}): Promise<{ sandbox: Sandbox; snapshotId?: string }> {
  const { branch, authRepoUrl, requirementId, instanceType, title, auditCtx, isPushRecovery } = params;
    let snapshotId: string;
    try {
      try {
        await params.sandbox.extendTimeout(2 * 60 * 1000);
      } catch {
        /* ignore */
      }
      const snap = await params.sandbox.snapshot({ expiration: 0 });
      snapshotId = snap.snapshotId;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[Sandbox] post-push snapshot() failed:', msg);
      
      // Si el snapshot falla porque el sandbox expiró (410 Gone o 404 Not Found),
      // no podemos retornar el mismo sandbox viejo porque está muerto.
      // Debemos forzar la creación de uno nuevo desde Git.
      if (/\b410\b/.test(msg) || /\b404\b/.test(msg)) {
        console.warn(`[Sandbox] Sandbox is gone (${msg}). Provisioning fresh git sandbox instead of reusing dead VM.`);
        const recovered = await SandboxService.createRequirementSandbox(
          requirementId,
          instanceType,
          title,
          auditCtx,
          undefined,
          { skipSnapshotReuse: true },
        );
        return { sandbox: recovered.sandbox };
      }
      
      return { sandbox: params.sandbox };
    }

  let next: Sandbox | undefined;
  try {
    // Fetch the previous snapshot ID before creating a new one
    // so we can delete it later to avoid billing leaks
    const previousSnapshotRow = await fetchLatestRequirementSnapshotRow(requirementId, auditCtx?.instanceId);
    const previousSnapshotId = previousSnapshotRow?.snapshot_id;

    next = await Sandbox.create({
      runtime: 'node24',
      timeout: SANDBOX_CREATE_TIMEOUT_MS,
      source: { type: 'snapshot', snapshotId },
    } as any);
    
    // Inmediatamente después de crear el nuevo, intentamos detener el viejo
    // sin importar si el resto del setup del nuevo falla o tiene éxito.
    // Esto previene que el viejo quede huérfano si el setup del nuevo lanza una excepción.
    if (params.sandbox.sandboxId !== next.sandboxId) {
      console.warn(`[Sandbox] 🧹 CLEANUP: Stopping old sandbox ${params.sandbox.sandboxId} after successful recreate into ${next.sandboxId}`);
      
      if (auditCtx?.instanceId) {
        // Update the DB to point to the new sandbox immediately
        await persistActiveSandboxId(requirementId, auditCtx.instanceId, next.sandboxId, auditCtx.siteId)
          .catch(e => console.error(`[Sandbox] Failed to update active_sandbox_id to ${next!.sandboxId}:`, e));
      }

      // No hacemos await aquí para no bloquear el setup del nuevo sandbox, 
      // pero aseguramos que el proceso de apagado comience.
      stopSandboxQuiet(params.sandbox).catch(e => {
        console.error(`[Sandbox] 🚨 ZOMBIE ALERT: Background stop for ${params.sandbox.sandboxId} failed:`, e);
      });
      
      // Delete the previous snapshot since we just created a new one
      // This prevents Sandbox Storage billing accumulation
      if (previousSnapshotId && previousSnapshotId !== snapshotId) {
        deleteSnapshotQuiet(previousSnapshotId).catch(e => {
          console.error(`[Sandbox] 🚨 ZOMBIE ALERT: Failed to delete previous snapshot ${previousSnapshotId}:`, e);
        });
      }
    }

    try {
      await next.extendTimeout(EXTEND_AFTER_CREATE_MS);
    } catch {
      /* ignore */
    }
    await logCronInfrastructureEvent(auditCtx, {
      event: CronInfraEvent.SANDBOX_VM_CREATED,
      message: 'Vercel Sandbox VM recreated from post-push snapshot',
      details: { requirementId, instanceType, snapshotId },
    });
    
    await installGitIdentity(next, authRepoUrl);
    const workDir = SandboxService.WORK_DIR;
    const fetchRes = await SandboxService.runCommandInSandbox(next, 'git', ['fetch', '--all'], workDir);
    if (fetchRes.exitCode !== 0) {
      throw new Error(`fetch after snapshot recreate failed: ${fetchRes.stderr}`);
    }
    if (!isPushRecovery) {
      const trackRes = await next.runCommand({
        cmd: 'git',
        args: ['checkout', '--track', `origin/${branch}`],
        cwd: workDir,
      });
      if (trackRes.exitCode !== 0) {
        const fb = await next.runCommand({
          cmd: 'git',
          args: ['checkout', '-B', branch, `origin/${branch}`],
          cwd: workDir,
        });
        if (fb.exitCode !== 0) {
          throw new Error(`checkout origin/${branch} after recreate failed: ${await fb.stderr()}`);
        }
      }
      await SandboxService.syncTrackedBranchToRemoteTip(next, branch);
    } else {
      console.log(`[Sandbox] Skipping git checkout/sync because this is a push recovery snapshot.`);
    }
    await next.runCommand({
      cmd: 'npm',
      args: ['install', '--prefer-offline', '--no-audit', '--no-fund'],
      cwd: workDir,
    });
    await assertPlatformGitLayout(next);
    return { sandbox: next, snapshotId };
  } catch (e: unknown) {
    if (next) {
      await stopSandboxQuiet(next);
    }
    console.error(
      '[Sandbox] recreate from post-push snapshot failed; provisioning fresh git sandbox:',
      e instanceof Error ? e.message : e,
    );
    const recovered = await SandboxService.createRequirementSandbox(
      requirementId,
      instanceType,
      title,
      auditCtx,
      undefined,
      { skipSnapshotReuse: true },
    );
    return { sandbox: recovered.sandbox };
  }
}
