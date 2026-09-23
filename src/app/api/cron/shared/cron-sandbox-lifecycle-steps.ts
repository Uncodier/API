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
import {
  captureSandboxTestFingerprint,
  isSandboxTestCommand,
  persistSandboxTestReceipt,
} from '@/app/api/agents/tools/sandbox/sandbox-test-receipt';
import { sanitizeRuntimeLog } from './runtime-log-context';

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
  audit?: CronAuditContext,
  backlogItemId?: string,
): Promise<{
  isRunning: boolean;
  output: string;
  exitCode?: number | null;
}> {
  'use step';
  const sandbox = await getSandboxHandle(sandboxId);
  let isRunning: boolean | undefined;
  let exitCode: number | null | undefined;
  const getCommand = (
    sandbox as unknown as {
      getCommand?: (
        commandId: string,
      ) => Promise<{ exitCode?: number | null }>;
    }
  ).getCommand;
  if (typeof getCommand === 'function') {
    try {
      const command = await getCommand.call(sandbox, pid);
      isRunning = command.exitCode == null;
      exitCode = command.exitCode;
    } catch {
      // Legacy process ids are handled below.
    }
  }
  if (isRunning === undefined) {
    const checkResult = await SandboxService.runCommandInSandbox(
      sandbox,
      'sh',
      ['-c', `kill -0 ${pid} 2>/dev/null && echo "RUNNING" || echo "STOPPED"`],
    );
    isRunning = checkResult.stdout.trim() === 'RUNNING';
    if (!isRunning) {
      try {
        const rawExitCode = await sandbox.fs.readFile(
          `${logFile}.exit`,
          'utf8',
        );
        const parsed = Number.parseInt(String(rawExitCode).trim(), 10);
        exitCode = Number.isInteger(parsed) ? parsed : null;
      } catch {
        exitCode = null;
      }
    }
  }
  const logResult = await SandboxService.runCommandInSandbox(sandbox, 'tail', ['-n', '200', logFile]);
  if (!isRunning && typeof exitCode === 'number') {
    try {
      const command = String(
        await sandbox.fs.readFile(`${logFile}.command`, 'utf8'),
      ).trim();
      if (isSandboxTestCommand(command)) {
        const startingFingerprint = String(
          await sandbox.fs.readFile(`${logFile}.fingerprint`, 'utf8'),
        ).trim();
        const currentFingerprint =
          await captureSandboxTestFingerprint(sandbox);
        await persistSandboxTestReceipt({
          sandbox,
          requirementId: audit?.requirementId,
          backlogItemId,
          stepId: audit?.stepId,
          command,
          exitCode,
          output: logResult.stdout,
          workspaceFingerprint: currentFingerprint,
          ranAfterChanges:
            !!startingFingerprint &&
            startingFingerprint === currentFingerprint,
        });
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.STEP_STATUS,
          level: exitCode === 0 ? 'info' : 'warn',
          message:
            `Background test command finished with exit code ${exitCode}: ${command}`,
          details: {
            command,
            exit_code: exitCode,
            output_tail:
              sanitizeRuntimeLog(logResult.stdout).slice(-1_200),
            workspace_fingerprint: currentFingerprint,
          },
        });
      }
    } catch (error: unknown) {
      console.warn(
        '[CronSandbox] Could not persist background test receipt:',
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { isRunning, output: logResult.stdout, exitCode };
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
    
    // Explicitly resume the sandbox bypassing runCommand's "use step" wrapper.
    // This avoids a 3-retry loop in the Vercel Workflows engine when the sandbox is dead (410).
    if (typeof (sandbox as any).resume === 'function') {
      try {
        await (sandbox as any).resume();
      } catch (resumeErr: any) {
        if (resumeErr?.response?.status === 410 || String(resumeErr?.message).includes('410')) {
          console.warn(`[CronStep] Not reusing ${idOrName}: sandbox dead (410)`);
          return null;
        }
        throw resumeErr;
      }
    }
  } catch (err) {
    console.warn(`[CronStep] getSandboxHandle failed for ${idOrName}:`, err instanceof Error ? err.message : err);
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
  
  let branchName: string;
  try {
    branchName = await SandboxService.getCurrentBranch(sandbox);
  } catch (e: unknown) {
    console.warn(
      `[CronStep] Failed to get branch on ${idOrName} (sandbox dead?), forcing reprovision:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }

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
