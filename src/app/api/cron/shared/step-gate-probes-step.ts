'use step';

import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { runRuntimeAndVisualProbes, type ProbeSignals } from './step-gate-probes';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

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
  };
  instanceType: string;
  title: string;
}): Promise<{
  ok: boolean;
  error?: string;
  signals: ProbeSignals;
  effectiveSandboxId: string;
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

  const result = await runRuntimeAndVisualProbes({
    sandbox: connected.sandbox,
    stepOrder: params.stepOrder,
    requirementId: params.requirementId,
    gitRepoKind: params.gitRepoKind,
    audit: params.audit,
    shouldRunVisual: params.shouldRunVisual,
    stepContext: params.stepContext,
  });

  return {
    ...result,
    effectiveSandboxId: connected.sandboxId,
  };
}
