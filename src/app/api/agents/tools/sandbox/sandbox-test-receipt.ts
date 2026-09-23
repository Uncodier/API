import type { Sandbox } from '@vercel/sandbox';
import { writeEvidence } from '@/lib/services/requirement-ground-truth';
import { SandboxService } from '@/lib/services/sandbox-service';
import { computeApplicationBuildFingerprint } from '@/app/api/cron/shared/commit/pre-push-build-validation';
import { sanitizeRuntimeLog } from '@/app/api/cron/shared/runtime-log-context';

export function isSandboxTestCommand(command: string): boolean {
  return (
    /\b(?:jest|vitest|mocha|playwright\s+test|node\s+--test)\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w.-]+)?\b/i.test(command)
  );
}

export async function captureSandboxTestFingerprint(
  sandbox: Sandbox,
): Promise<string | undefined> {
  return await computeApplicationBuildFingerprint(
    sandbox,
    SandboxService.WORK_DIR,
  ) || undefined;
}

export async function persistSandboxTestReceipt(params: {
  sandbox: Sandbox;
  requirementId?: string;
  backlogItemId?: string;
  stepId?: string;
  command: string;
  exitCode: number;
  output: string;
  workspaceFingerprint?: string;
  ranAfterChanges: boolean;
}): Promise<void> {
  if (
    !params.requirementId ||
    !params.backlogItemId ||
    !params.stepId ||
    !params.workspaceFingerprint ||
    !isSandboxTestCommand(params.command)
  ) {
    return;
  }

  const capturedAt = new Date().toISOString();
  await writeEvidence({
    requirementId: params.requirementId,
    itemId: params.backlogItemId,
    requireCanonicalPersistence: true,
    record: {
      producer_step_id: params.stepId,
      workspace_fingerprint: params.workspaceFingerprint,
      captured_at: capturedAt,
      tests: [{
        command: params.command.trim(),
        exit_code: params.exitCode,
        output_tail: sanitizeRuntimeLog(params.output).slice(-6_000),
        ran_after_changes: params.ranAfterChanges,
        captured_at: capturedAt,
        step_id: params.stepId,
        workspace_fingerprint: params.workspaceFingerprint,
      }],
    },
  });
}
