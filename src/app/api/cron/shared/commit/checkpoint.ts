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
    const msg = (e?.message || e).toString();
    console.error(
      `[CronPersist] CHECKPOINT_FAILED step=${planStep.order}:`,
      msg,
      e?.stack,
    );
    
    // Si el sandbox murió (410), no es un error de código, es de infraestructura.
    // Como el agente ya hizo su propio push (sandbox_push_checkpoint), este paso redundante
    // puede fallar silenciosamente si el contenedor expiró, sin ensuciar los logs de infra.
    if (/\b410\b/.test(msg)) {
      console.log(`[CronPersist] Checkpoint redundante omitido para el paso ${planStep.order} (el sandbox expiró pero el agente ya había hecho push)`);
      return;
    }

    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.CHECKPOINT,
      level: 'error',
      message: `Checkpoint failed after step ${planStep.order}: ${msg.slice(0, 400)}`,
      details: { step_order: planStep.order, step_id: planStep.id },
    });
    throw e;
  }
}
