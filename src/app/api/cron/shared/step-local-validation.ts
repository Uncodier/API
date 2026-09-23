import type { Sandbox } from '@vercel/sandbox';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
} from '@/lib/services/cron-audit-log';
import type { GitRepoKind } from './cron-commit-helpers';
import type { BuildSignal } from './step-iteration-signals';
import {
  runDeclaredTestCommand,
  type TestSignal,
} from './step-test-evidence';
import type { ReusableGateValidation } from './gate-validation-cache';
import { SandboxService } from '@/lib/services/sandbox-service';
import { isSandboxGoneError } from '@/lib/services/sandbox-gone-error';
import { validateNpmRepoForVercelDeploy } from './vercel-npm-repo-guard';
import {
  computeApplicationBuildFingerprint,
  recordSuccessfulApplicationBuild,
} from './commit/pre-push-build-validation';

const SANDBOX_BUILD_OUTPUT_MAX = 6_000;

export interface LocalGateValidationSignals {
  build?: BuildSignal;
  tests?: TestSignal;
  workspace_fingerprint?: string;
}

export async function validateBuildForStep(
  sandbox: Sandbox,
): Promise<string | null> {
  const cwd = SandboxService.WORK_DIR;
  const result = await sandbox.runCommand(
    'sh',
    ['-c', `cd ${cwd} && npm run build 2>&1`],
  );
  if (result.exitCode === 0) return null;

  const [stdout, stderr] = await Promise.all([
    result.stdout().catch(() => ''),
    result.stderr().catch(() => ''),
  ]);
  const combined = `${stdout}${stderr ? `\n${stderr}` : ''}`;
  const tail = combined.length > SANDBOX_BUILD_OUTPUT_MAX
    ? `…(truncated ${combined.length - SANDBOX_BUILD_OUTPUT_MAX} earlier chars)\n${combined.slice(-SANDBOX_BUILD_OUTPUT_MAX)}`
    : combined;
  return `Build failed (npm run build, exit ${result.exitCode}):\n${tail}`;
}

async function recordBuildMarker(
  sandbox: Sandbox,
  workspaceFingerprint?: string,
): Promise<void> {
  try {
    await recordSuccessfulApplicationBuild(
      sandbox,
      SandboxService.WORK_DIR,
      workspaceFingerprint,
    );
  } catch (error: unknown) {
    console.warn(
      '[GateStep] Could not record reusable build marker:',
      error instanceof Error ? error.message : error,
    );
  }
}

async function normalizeApplicationLayout(sandbox: Sandbox): Promise<void> {
  const cwd = SandboxService.WORK_DIR;
  try {
    const result = await sandbox.runCommand('sh', [
      '-c',
      `cd "${cwd}" || exit 0
if [ -d src/app ] && [ -d app/src/app ] && [ ! -f app/package.json ]; then
  rm -rf app
  echo FIX_RM_DUP
fi
if [ -f package.json ] && [ ! -f app/package.json ] && [ -d app/src/app ] && [ ! -d src/app ]; then
  mkdir -p src
  mv app/src/app src/app
  rm -rf app
  echo FIX_MV_APP
fi
if [ -d src/app ] && [ -d app ] && [ ! -f app/package.json ] && [ ! -d app/src/app ]; then
  rm -rf app
  echo FIX_RM_ORPHAN
fi`,
    ]);
    const message = (await result.stdout()).trim();
    if (message.includes('FIX_RM_DUP')) {
      console.log('[GateStep] Removed duplicate root app/');
    }
    if (message.includes('FIX_MV_APP')) {
      console.log('[GateStep] Moved app/src/app to src/app');
    }
    if (message.includes('FIX_RM_ORPHAN')) {
      console.log('[GateStep] Removed orphan root app/');
    }
  } catch (error: unknown) {
    console.warn(
      '[GateStep] Layout normalization failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

export async function runLocalGateValidation(params: {
  sandbox: Sandbox;
  stepId?: string;
  stepOrder?: number;
  testCommand?: string;
  gitRepoKind: GitRepoKind;
  audit?: CronAuditContext;
  workspaceFingerprint?: string;
  reusableValidation?: ReusableGateValidation;
}): Promise<{
  ok: boolean;
  error?: string;
  infrastructureFailure?: boolean;
  sandboxUnavailable?: boolean;
  signals: LocalGateValidationSignals;
}> {
  const signals: LocalGateValidationSignals = {};
  let workspaceFingerprint = params.workspaceFingerprint;

  if (params.reusableValidation?.buildPassed && workspaceFingerprint) {
    signals.build = { ok: true, duration_ms: 0 };
    await recordBuildMarker(params.sandbox, workspaceFingerprint);
    await logCronInfrastructureEvent(params.audit, {
      event: CronInfraEvent.GATE_BUILD,
      message: `${params.stepOrder !== undefined ? `Step ${params.stepOrder} ` : ''}gate: reused unchanged npm build`,
      details: {
        stepOrder: params.stepOrder,
        workspace_fingerprint: workspaceFingerprint,
        reused: true,
      },
    });
  } else {
    await normalizeApplicationLayout(params.sandbox);
    const layoutError = await validateNpmRepoForVercelDeploy(
      params.sandbox,
      params.gitRepoKind,
    );
    if (layoutError) {
      const message = `Vercel/npm layout: ${layoutError}`;
      signals.build = { ok: false, layout_error: layoutError };
      const gone = isSandboxGoneError(message);
      return {
        ok: false,
        error: message,
        signals,
        ...(gone ? { sandboxUnavailable: true } : {}),
      };
    }

    const buildStartedAt = Date.now();
    const buildError = await validateBuildForStep(params.sandbox);
    const buildDurationMs = Date.now() - buildStartedAt;
    if (buildError) {
      signals.build = {
        ok: false,
        duration_ms: buildDurationMs,
        error_tail: buildError,
      };
      const gone = isSandboxGoneError(buildError);
      await logCronInfrastructureEvent(params.audit, {
        event: CronInfraEvent.GATE_BUILD,
        level: gone ? 'warn' : 'error',
        message: `${params.stepOrder !== undefined ? `Step ${params.stepOrder} ` : ''}gate: npm run build failed`,
        details: {
          stepOrder: params.stepOrder,
          duration_ms: buildDurationMs,
          error: buildError.slice(0, 1_200),
          sandbox_unavailable: gone,
        },
      });
      return {
        ok: false,
        error: buildError,
        signals,
        ...(gone ? { sandboxUnavailable: true } : {}),
      };
    }

    signals.build = { ok: true, duration_ms: buildDurationMs };
    workspaceFingerprint =
      await computeApplicationBuildFingerprint(
        params.sandbox,
        SandboxService.WORK_DIR,
      ) || undefined;
    await recordBuildMarker(params.sandbox, workspaceFingerprint);
    await logCronInfrastructureEvent(params.audit, {
      event: CronInfraEvent.GATE_BUILD,
      message: `${params.stepOrder !== undefined ? `Step ${params.stepOrder} ` : ''}gate: npm run build passed`,
      details: {
        stepOrder: params.stepOrder,
        duration_ms: buildDurationMs,
        workspace_fingerprint: workspaceFingerprint,
      },
    });
  }

  workspaceFingerprint ??=
    await computeApplicationBuildFingerprint(
      params.sandbox,
      SandboxService.WORK_DIR,
    ) || undefined;
  if (workspaceFingerprint) {
    signals.workspace_fingerprint = workspaceFingerprint;
  }

  const testCommand = params.testCommand?.trim();
  if (!testCommand) return { ok: true, signals };

  try {
    const reusedTests = params.reusableValidation?.tests;
    const fingerprintBeforeTests = workspaceFingerprint;
    const tests = reusedTests ?? (
      await runDeclaredTestCommand(params.sandbox, testCommand, {
        stepId: params.stepId,
        workspaceFingerprint,
      })
    );
    const fingerprintAfterTests = reusedTests
      ? workspaceFingerprint
      : await computeApplicationBuildFingerprint(
          params.sandbox,
          SandboxService.WORK_DIR,
        ) || undefined;
    if (
      !reusedTests &&
      (!fingerprintBeforeTests || !fingerprintAfterTests)
    ) {
      tests.ok = false;
      tests.tests = tests.tests.map((test) => ({
        ...test,
        ran_after_changes: false,
      }));
      signals.tests = tests;
      return {
        ok: false,
        error:
          `Declared test command completed, but the workspace fingerprint ` +
          `could not be verified before and after execution: ${testCommand}`,
        infrastructureFailure: true,
        signals,
      };
    }
    if (
      fingerprintBeforeTests &&
      fingerprintAfterTests &&
      fingerprintBeforeTests !== fingerprintAfterTests
    ) {
      tests.ok = false;
      tests.tests = tests.tests.map((test) => ({
        ...test,
        ran_after_changes: false,
      }));
    }
    workspaceFingerprint = fingerprintAfterTests ?? workspaceFingerprint;
    if (workspaceFingerprint) {
      signals.workspace_fingerprint = workspaceFingerprint;
    }
    signals.tests = tests;

    const reused = reusedTests === tests;
    await logCronInfrastructureEvent(params.audit, {
      event: CronInfraEvent.STEP_STATUS,
      level: tests.ok ? 'info' : 'error',
      message:
        `${params.stepOrder !== undefined ? `Step ${params.stepOrder} ` : ''}` +
        `declared test command ${tests.ok ? 'passed' : 'failed'}` +
        `${reused ? ' (reused unchanged receipt)' : ''}`,
      details: {
        stepOrder: params.stepOrder,
        command: testCommand,
        exit_code: tests.tests[0]?.exit_code,
        output_tail: tests.tests[0]?.output_tail.slice(-1_200),
        workspace_fingerprint: workspaceFingerprint,
        reused,
      },
    });
    if (!tests.ok) {
      const changedWorkspace = tests.tests.some(
        (test) => !test.ran_after_changes,
      );
      return {
        ok: false,
        error: changedWorkspace
          ? `Declared test command changed product files; rerun it against the resulting workspace: ${testCommand}`
          : `Declared test command failed: ${testCommand}\n${tests.tests[0]?.output_tail || ''}`,
        signals,
      };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const gone = isSandboxGoneError(message);
    return {
      ok: false,
      error: `Declared test command unavailable: ${message}`,
      infrastructureFailure: true,
      signals,
      ...(gone ? { sandboxUnavailable: true } : {}),
    };
  }

  return { ok: true, signals };
}
