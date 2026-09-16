'use step';

import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { runRuntimeAndVisualProbes, type ProbeSignals } from './step-gate-probes';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import { runInteractionAudit } from './step-interaction-runner';
import { applyInteractionBacklogPolicy } from './step-interaction-backlog';
import { formatInteractionFailure } from './step-interaction-audit';
import { SandboxService } from '@/lib/services/sandbox-service';

export async function runGateProbesStep(params: {
  sandboxId: string;
  stepOrder: number;
  requirementId: string;
  gitRepoKind: 'applications' | 'automation';
  audit?: CronAuditContext;
  shouldRunVisual?: boolean;
  stepContext?: {
    title?: string;
    instructions?: string;
    expected_output?: string;
    brand_context?: string;
    protected_routes?: string[];
  };
  instanceType: string;
  title: string;
  changeBaselineSha?: string | null;
}): Promise<{
  ok: boolean;
  error?: string;
  infrastructureFailure?: boolean;
  signals: ProbeSignals;
  effectiveSandboxId: string;
  changeBaselineSha: string | null;
}> {
  'use step';
  const { sandboxId, requirementId, instanceType, title, audit } = params;
  
  const connected = await connectOrRecreateRequirementSandbox({
    sandboxId,
    requirementId,
    instanceType,
    title,
    audit,
  });
  let changeBaselineSha = params.changeBaselineSha || null;
  if (!changeBaselineSha) {
    const head = await connected.sandbox.runCommand('git', [
      '-C',
      SandboxService.WORK_DIR,
      'rev-parse',
      'HEAD',
    ]);
    if (head.exitCode === 0) {
      changeBaselineSha = (await head.stdout()).trim() || null;
    }
  }

  const scannedInteraction = await runInteractionAudit(connected.sandbox, {
    baselineSha: changeBaselineSha,
  });
  const interaction = await applyInteractionBacklogPolicy({
    requirementId: params.requirementId,
    signal: scannedInteraction,
  });
  if (!interaction.ok) {
    return {
      ok: false,
      error: formatInteractionFailure(interaction),
      signals: { interaction },
      effectiveSandboxId: connected.sandboxId,
      changeBaselineSha,
    };
  }

  const result = await runRuntimeAndVisualProbes({
    sandbox: connected.sandbox,
    stepOrder: params.stepOrder,
    requirementId: params.requirementId,
    gitRepoKind: params.gitRepoKind,
    audit: params.audit,
    shouldRunVisual: params.shouldRunVisual,
    stepContext: params.stepContext,
    changeBaselineSha,
  });
  result.signals.interaction = interaction;
  if (result.infrastructureFailure) {
    throw new Error(result.error || 'Maintenance gate infrastructure unavailable');
  }

  return {
    ...result,
    effectiveSandboxId: connected.sandboxId,
    changeBaselineSha,
  };
}
