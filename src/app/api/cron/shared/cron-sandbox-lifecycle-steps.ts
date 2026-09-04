'use step';

import { getSandboxHandle, sandboxIdentity } from '@/lib/services/sandbox-sdk';
import { requirementSandboxName } from '@/lib/services/sandbox-constants';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { SandboxService } from '@/lib/services/sandbox-service';
import { inspectSandboxWorkspace } from '@/lib/services/sandbox-recovery';
import { warmStartNamedSandbox } from '@/lib/services/sandbox-on-resume';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import {
  releaseRunLock as _releaseRunLockImpl,
  extendRunLock as _extendRunLockImpl,
  CRON_RUN_LOCK_TTL_MS,
} from './cron-run-lock';

export interface SandboxInfo {
  sandboxId: string;
  branchName: string;
  workDir: string;
  isNewBranch: boolean;
  instanceType: string;
}

export async function checkBackgroundCommandStep(
  sandboxId: string,
  pid: string,
  logFile: string,
  _audit?: CronAuditContext,
): Promise<{ isRunning: boolean; output: string }> {
  'use step';
  const sandbox = await getSandboxHandle(sandboxId);
  const checkResult = await SandboxService.runCommandInSandbox(sandbox, 'sh', ['-c', `kill -0 ${pid} 2>/dev/null && echo "RUNNING" || echo "STOPPED"`]);
  const status = checkResult.stdout.trim();
  const logResult = await SandboxService.runCommandInSandbox(sandbox, 'tail', ['-n', '200', logFile]);
  return { isRunning: status === 'RUNNING', output: logResult.stdout };
}

export async function createSandboxStep(
  reqId: string,
  instanceType: string,
  title: string,
  audit?: CronAuditContext,
): Promise<SandboxInfo> {
  'use step';

  const namedId = requirementSandboxName(reqId, audit?.instanceId);
  const reusedNamed = await tryReuseExistingSandbox(namedId, reqId, instanceType);
  if (reusedNamed) return reusedNamed;

  if (audit?.instanceId) {
    const { data: reqStatus, error } = await supabaseAdmin
      .from('requirement_status')
      .select('active_sandbox_id')
      .eq('requirement_id', reqId)
      .eq('instance_id', audit.instanceId)
      .not('active_sandbox_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(`[CronStep] Error fetching active_sandbox_id:`, error);
    }

    if (reqStatus?.active_sandbox_id) {
      const reusedDb = await tryReuseExistingSandbox(reqStatus.active_sandbox_id, reqId, instanceType);
      if (reusedDb) return reusedDb;
      console.warn(`[CronStep] Existing active sandbox ${reqStatus.active_sandbox_id} is gone or fatal. Provisioning new one.`);
    }
  }

  const result = await SandboxService.createRequirementSandbox(reqId, instanceType, title, audit);

  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.WORKFLOW_SANDBOX_READY,
    message: `Sandbox ready for cron (VM + git + npm): ${sandboxIdentity(result.sandbox)} @ ${result.branchName}`,
    details: {
      sandboxId: sandboxIdentity(result.sandbox),
      branchName: result.branchName,
      workDir: result.workDir,
      isNewBranch: result.isNewBranch,
      instanceType: result.instanceType,
      requirementId: reqId,
    },
  });

  return {
    sandboxId: sandboxIdentity(result.sandbox),
    branchName: result.branchName,
    workDir: result.workDir,
    isNewBranch: result.isNewBranch,
    instanceType: result.instanceType,
  };
}

async function tryReuseExistingSandbox(
  idOrName: string,
  reqId: string,
  instanceType: string,
): Promise<SandboxInfo | null> {
  let sandbox;
  try {
    sandbox = await getSandboxHandle(idOrName);
  } catch {
    return null;
  }
  const ping = await inspectSandboxWorkspace(sandbox);
  if (ping.fatal) {
    console.warn(`[CronStep] Not reusing ${idOrName}: fatal layout ${ping.reason}`);
    return null;
  }
  await warmStartNamedSandbox(sandbox, reqId, instanceType).catch((e: unknown) => {
    console.warn(
      `[CronStep] warmStart on ${idOrName} failed — keeping existing VM:`,
      e instanceof Error ? e.message : e,
    );
  });
  const branchName = await SandboxService.getCurrentBranch(sandbox);
  console.log(`[CronStep] Reusing sandbox ${idOrName} (ping=${ping.ok ? 'ok' : ping.reason || 'fail'})`);
  return {
    sandboxId: sandboxIdentity(sandbox) || idOrName,
    branchName,
    workDir: SandboxService.WORK_DIR,
    isNewBranch: false,
    instanceType,
  };
}

export async function stopSandboxStep(sandboxId: string, audit?: CronAuditContext) {
  'use step';

  if (audit?.instanceId && audit?.requirementId && !String(sandboxId).startsWith('req-')) {
    await supabaseAdmin
      .from('requirement_status')
      .update({ active_sandbox_id: null })
      .eq('requirement_id', audit.requirementId)
      .eq('instance_id', audit.instanceId)
      .eq('active_sandbox_id', sandboxId);
  }

  let delayMs = 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sandbox = await getSandboxHandle(sandboxId);
      await sandbox.stop();
      console.log(`[CronStep] CLEANUP: Sandbox ${sandboxId} stopped`);
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.SANDBOX_STOP,
        message: `Sandbox stopped (${sandboxId})`,
        details: { sandboxId },
      });
      return;
    } catch (e: unknown) {
      if (attempt < 2) {
        console.warn(`[CronStep] CLEANUP: Sandbox stop attempt ${attempt + 1} failed (${sandboxId}). Retrying in ${delayMs}ms...`);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      } else {
        console.warn(`[CronStep] ZOMBIE ALERT: Sandbox stop skipped or failed (${sandboxId}) after 3 attempts`, e);
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.SANDBOX_STOP,
          level: 'warn',
          message: `ZOMBIE ALERT: Sandbox stop skipped or failed (${sandboxId}) after 3 attempts`,
          details: { sandboxId, error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
  }
}

export async function extendRunLockStep(
  requirementId: string,
  runId: string | undefined,
  ttlMs: number = CRON_RUN_LOCK_TTL_MS,
): Promise<void> {
  'use step';
  if (!runId) return;
  await _extendRunLockImpl(requirementId, runId, ttlMs);
}

export async function releaseRunLockStep(
  requirementId: string,
  runId: string | undefined,
): Promise<void> {
  'use step';
  if (!runId) return;
  await _releaseRunLockImpl(requirementId, runId);
}
