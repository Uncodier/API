/**
 * Deterministic cron / infrastructure events → Supabase `instance_logs` only (Makinari).
 * Do not rely on console; filter by log_type = infrastructure or details.source = cron_infrastructure.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';

/** siteId is required to persist; instanceId optional (stored null if missing). */
export type CronAuditContext = {
  siteId: string;
  instanceId?: string;
  userId?: string;
  requirementId?: string;
};

/** Stable event names for dashboards / SQL filters */
export const CronInfraEvent = {
  SANDBOX_VM_CREATED: 'cron_infra_sandbox_vm_created',
  /** After createSandboxStep — includes sandboxId for debugging */
  WORKFLOW_SANDBOX_READY: 'cron_infra_workflow_sandbox_ready',
  /** Previous VM was gone; new Sandbox.create + git checkout aligned to origin */
  SANDBOX_REPROVISIONED: 'cron_infra_sandbox_reprovisioned',
  GIT_WORKSPACE_READY: 'cron_infra_git_workspace_ready',
  NESTED_DIRS_CLEANUP: 'cron_infra_nested_dirs_cleanup',
  COMMIT_PUSH: 'cron_infra_commit_push',
  CHECKPOINT: 'cron_infra_checkpoint',
  STEP_STATUS: 'cron_infra_step_status',
  GATE_BUILD: 'cron_infra_gate_build',
  GATE_ORIGIN: 'cron_infra_gate_origin',
  /** GitHub deployment status (Vercel integration) after push — preview URL + success/failure */
  GATE_VERCEL_DEPLOY: 'cron_infra_gate_vercel_deploy',
  /** Build stdout/stderr excerpt from Vercel REST API (deployment events) after gate resolves */
  VERCEL_BUILD_LOG: 'cron_infra_vercel_build_log',
  GATE_PUSH_RECOVERY: 'cron_infra_gate_push_recovery',
  SMOKE_TEST: 'cron_infra_smoke_test',
  /** Per-step server startup + page probe: starts next start, curls pages, captures stdout/stderr. */
  RUNTIME_PROBE: 'cron_infra_runtime_probe',
  /** Per-step API route probe: hits src/app/api/** routes with sampled payloads. */
  API_PROBE: 'cron_infra_api_probe',
  /** Per-step browser console + pageerror capture during visual probe. */
  CONSOLE_PROBE: 'cron_infra_console_probe',
  /** E2E scenario run outcome (pass/fail + artifacts). */
  SCENARIO_RUN: 'cron_infra_scenario_run',
  /** Per-step visual probe: screenshots + network trace at declared viewports. */
  VISUAL_PROBE: 'cron_infra_visual_probe',
  /** Vision-model critique verdict (pass/defects) over step screenshots. */
  VISUAL_CRITIC_VERDICT: 'cron_infra_visual_critic_verdict',
  /** Aggregated QA verdict combining runtime/api/console/scenarios/visual signals. */
  QA_VERDICT: 'cron_infra_qa_verdict',
  /** Step closed as completed but flagged for human review (visual budget exhausted with minor defects). */
  NEEDS_HUMAN_REVIEW: 'cron_infra_needs_human_review',
  PLAN_RECONCILE: 'cron_infra_plan_reconcile',
  POST_FINALLY_BUILD: 'cron_infra_post_finally_build',
  DELIVERABLES_VALIDATE: 'cron_infra_deliverables_validate',
  SANDBOX_STOP: 'cron_infra_sandbox_stop',
  FINAL_STATUS: 'cron_infra_final_status',
  /** Orchestrator run to rewrite instance_plan after executor + gate failures */
  PLAN_ADAPTATION: 'cron_infra_plan_adaptation',
  /** Plan was paused, cancelled, deleted, or no longer runnable — step loop stopped for this cron run */
  PLAN_EXECUTION_HALTED: 'cron_infra_plan_execution_halted',
  /** requirement_status.preview_url persisted (checkpoint patch, sync, or gate) */
  PREVIEW_URL_RECORDED: 'cron_infra_preview_url_recorded',
  /** Vercel webhook: deployment.created received (build queued) */
  VERCEL_WEBHOOK_DEPLOYMENT_CREATED: 'cron_infra_vercel_webhook_deployment_created',
  /** Vercel webhook: deployment.building / in-progress build */
  VERCEL_WEBHOOK_DEPLOYMENT_BUILDING: 'cron_infra_vercel_webhook_deployment_building',
  /** Vercel webhook: deployment.ready / deployment.succeeded (preview URL live) */
  VERCEL_WEBHOOK_DEPLOYMENT_READY: 'cron_infra_vercel_webhook_deployment_ready',
  /** Vercel webhook: deployment.error (build or runtime failure reported by Vercel) */
  VERCEL_WEBHOOK_DEPLOYMENT_ERROR: 'cron_infra_vercel_webhook_deployment_error',
  /** Vercel webhook: deployment.canceled */
  VERCEL_WEBHOOK_DEPLOYMENT_CANCELED: 'cron_infra_vercel_webhook_deployment_canceled',
  /** Vercel webhook: deployment.promoted (e.g. to production) */
  VERCEL_WEBHOOK_DEPLOYMENT_PROMOTED: 'cron_infra_vercel_webhook_deployment_promoted',
} as const;

/**
 * System row in instance_logs when a Vercel preview URL is stored on requirement_status (auditable per instance).
 */
export async function logInstancePreviewUrlRecorded(params: {
  siteId: string;
  instanceId?: string | null;
  userId?: string | null;
  requirementId: string;
  previewUrl: string;
  /** e.g. requirement_status_sync | requirement_status_patch | requirement_status_insert */
  context: string;
  repoUrl?: string | null;
}): Promise<void> {
  const { siteId, instanceId, userId, requirementId, previewUrl, context, repoUrl } = params;
  if (!siteId?.trim() || !previewUrl?.trim()) {
    return;
  }

  const short = previewUrl.length > 120 ? `${previewUrl.slice(0, 120)}…` : previewUrl;
  try {
    const { error } = await supabaseAdmin.from('instance_logs').insert({
      log_type: 'system',
      level: 'info',
      message: `Preview URL recorded for requirement ${requirementId}: ${short}`,
      instance_id: instanceId ?? null,
      site_id: siteId,
      user_id: userId ?? null,
      details: {
        source: 'requirement_preview_url',
        event: CronInfraEvent.PREVIEW_URL_RECORDED,
        requirement_id: requirementId,
        preview_url: previewUrl,
        repo_url: repoUrl ?? null,
        context,
      },
    });
    if (error) {
      console.warn(
        '[instance_logs] preview_url insert error:',
        error.message,
        (error as { details?: string }).details ?? '',
      );
    }
  } catch (e: unknown) {
    console.warn(
      '[instance_logs] preview_url log failed:',
      e instanceof Error ? e.message : e,
    );
  }
}

export async function logCronInfrastructureEvent(
  ctx: CronAuditContext | null | undefined,
  payload: {
    event: string;
    level?: 'info' | 'warn' | 'error';
    message: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  if (!ctx?.siteId) {
    return;
  }

  const level = payload.level ?? 'info';
  const details: Record<string, unknown> = {
    source: 'cron_infrastructure',
    event: payload.event,
    requirement_id: ctx.requirementId ?? null,
    ...payload.details,
  };
  if (!ctx.instanceId) {
    details.instance_id_missing = true;
  }

  try {
    const { error } = await supabaseAdmin.from('instance_logs').insert({
      log_type: 'infrastructure',
      level,
      message: payload.message,
      instance_id: ctx.instanceId ?? null,
      site_id: ctx.siteId,
      user_id: ctx.userId ?? null,
      details,
    });
    // The Supabase JS client does NOT throw on DB errors (e.g. CHECK / FK violations);
    // it returns { error }. Without this, infra logs (and any future log_type that the
    // schema doesn't allow yet) get dropped invisibly. Surface the failure so the next
    // missing-log debug session is one grep away.
    if (error) {
      console.warn(
        `[instance_logs] infrastructure log dropped (${payload.event}):`,
        error.message,
        (error as { details?: string }).details ?? '',
      );
    }
  } catch (e: unknown) {
    console.warn(
      `[instance_logs] infrastructure log threw (${payload.event}):`,
      e instanceof Error ? e.message : e,
    );
  }
}
