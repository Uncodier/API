import { Sandbox } from '@vercel/sandbox';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { commitWorkspaceToOrigin } from './commit-workspace';
import type { GitRepoKind } from './status-sync';

export type PlanStepCheckpointKind = 'success' | 'failed_validation' | 'failed_execution';

/**
 * Backs up sandbox work to origin after a successful step only.
 * On failed_validation / failed_execution we do NOT run platform commit/push.
 */
export async function checkpointPlanIteration(
  sandbox: Sandbox,
  title: string,
  reqId: string,
  planStep: any,
  kind: PlanStepCheckpointKind,
  audit?: CronAuditContext,
  opts?: { gitRepoKind?: GitRepoKind },
): Promise<void> {
  if (kind !== 'success') {
    console.log(
      `[CronPersist] checkpoint_skipped policy=no_platform_push_on_failure kind=${kind} step_order=${planStep.order} step_id=${planStep.id}`,
    );
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.CHECKPOINT,
      level: 'warn',
      message: `Platform checkpoint skipped (policy: no push on ${kind})`,
      details: {
        kind,
        step_order: planStep.order,
        step_id: planStep.id,
      },
    });
    return;
  }

  const stepLabel = String(planStep.title || 'step').replace(/\s+/g, ' ').trim().slice(0, 100);
  const body = `WIP: step ${planStep.order} — ${stepLabel}`;
  try {
    await commitWorkspaceToOrigin(sandbox, title, reqId, `${body} (${reqId})`, audit, {
      gitRepoKind: opts?.gitRepoKind,
    });
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.CHECKPOINT,
      message: `Post-step checkpoint finished for step ${planStep.order}`,
      details: { step_order: planStep.order, step_id: planStep.id, step_title: stepLabel },
    });
  } catch (e: any) {
    console.error(
      `[CronPersist] CHECKPOINT_FAILED step=${planStep.order}:`,
      e?.message || e,
      e?.stack,
    );
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.CHECKPOINT,
      level: 'error',
      message: `Checkpoint failed after step ${planStep.order}: ${(e?.message || e).toString().slice(0, 400)}`,
      details: { step_order: planStep.order, step_id: planStep.id },
    });
    throw e;
  }
}
