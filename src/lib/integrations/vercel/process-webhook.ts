/**
 * Vercel webhook → instance_logs + requirement_status.preview_url.
 *
 * This is the single place that maps a signed Vercel event to our production
 * loop: it records deployment state on `instance_logs` (so the robot instance
 * working the requirement has live context) and updates
 * `requirement_status.preview_url` when the deployment is ready, reusing the
 * same helper as the cron (`patchLatestRequirementStatusColumns`).
 *
 * No new tables, no new automations — if the event cannot be linked to a
 * requirement (e.g. main/master deploys), the event is skipped and 200 is
 * returned so Vercel does not retry.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { patchLatestRequirementStatusColumns } from '@/app/api/cron/shared/commit/status-sync';
import {
  isVercelDeploymentEventType,
  type VercelWebhookEvent,
  type VercelWebhookPayloadBody,
} from './webhook-types';
import { resolveVercelContext, type ResolvedVercelContext } from './webhook-resolver';

export type VercelWebhookOutcome =
  | { status: 'processed'; event: string; requirementId: string; updatedPreview: boolean }
  | { status: 'deduped'; event: string; requirementId: string | null }
  | { status: 'ignored'; event: string; reason: string };

/** Maximum characters stored in `details.commit_message` to keep log rows small. */
const COMMIT_MESSAGE_MAX = 300;
/** Maximum characters stored in `details.error_message`. */
const ERROR_MESSAGE_MAX = 500;

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function buildPreviewUrl(deploymentUrl: string | null | undefined): string | null {
  if (!deploymentUrl) return null;
  const trimmed = String(deploymentUrl).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed}`;
}

function shortReq(requirementId: string): string {
  return requirementId.slice(0, 8);
}

function mapEventTypeToInfra(type: string): {
  key: keyof typeof CronInfraEvent;
  level: 'info' | 'warn' | 'error';
} | null {
  switch (type) {
    case 'deployment.created':
      return { key: 'VERCEL_WEBHOOK_DEPLOYMENT_CREATED', level: 'info' };
    case 'deployment.building':
      return { key: 'VERCEL_WEBHOOK_DEPLOYMENT_BUILDING', level: 'info' };
    case 'deployment.ready':
    case 'deployment.succeeded':
      return { key: 'VERCEL_WEBHOOK_DEPLOYMENT_READY', level: 'info' };
    case 'deployment.error':
      return { key: 'VERCEL_WEBHOOK_DEPLOYMENT_ERROR', level: 'error' };
    case 'deployment.canceled':
      return { key: 'VERCEL_WEBHOOK_DEPLOYMENT_CANCELED', level: 'warn' };
    case 'deployment.promoted':
      return { key: 'VERCEL_WEBHOOK_DEPLOYMENT_PROMOTED', level: 'info' };
    default:
      return null;
  }
}

function buildLogDetails(
  event: VercelWebhookEvent,
  ctx: ResolvedVercelContext,
  previewUrl: string | null,
): Record<string, unknown> {
  const d = event.payload.deployment ?? {};
  const meta = d.meta ?? {};
  return {
    source: 'vercel_webhook',
    raw_event_id: event.id,
    raw_event_type: event.type,
    raw_created_at: event.createdAt,
    deployment_id: d.id ?? null,
    deployment_url: previewUrl,
    deployment_target: d.target ?? null,
    deployment_source: d.source ?? null,
    inspector_url: d.inspectorUrl ?? null,
    project_id: event.payload.projectId ?? event.payload.project?.id ?? null,
    project_name: event.payload.project?.name ?? d.name ?? null,
    branch: ctx.branch,
    commit_sha: meta.githubCommitSha ?? null,
    commit_message: truncate(meta.githubCommitMessage, COMMIT_MESSAGE_MAX),
    commit_author: meta.githubCommitAuthorLogin ?? meta.githubCommitAuthorName ?? null,
    github_org: meta.githubOrg ?? null,
    github_repo: meta.githubRepo ?? null,
    git_repo_kind: ctx.gitRepoKind,
    error_code: event.payload.errorCode ?? null,
    error_message: truncate(event.payload.errorMessage, ERROR_MESSAGE_MAX),
  };
}

function buildLogMessage(
  event: VercelWebhookEvent,
  ctx: ResolvedVercelContext,
  previewUrl: string | null,
): string {
  const rid = ctx.requirementId ? shortReq(ctx.requirementId) : 'unknown';
  const err = truncate(event.payload.errorMessage, 160);
  switch (event.type) {
    case 'deployment.created':
      return `Vercel deployment created for req-${rid} on ${ctx.branch ?? 'unknown-branch'}`;
    case 'deployment.building':
      return `Vercel deployment building for req-${rid}`;
    case 'deployment.ready':
    case 'deployment.succeeded':
      return previewUrl
        ? `Vercel deployment ready for req-${rid} (preview: ${previewUrl})`
        : `Vercel deployment ready for req-${rid}`;
    case 'deployment.error':
      return `Vercel deployment failed for req-${rid}${err ? `: ${err}` : ''}`;
    case 'deployment.canceled':
      return `Vercel deployment canceled for req-${rid}`;
    case 'deployment.promoted':
      return `Vercel deployment promoted for req-${rid}`;
    default:
      return `Vercel ${event.type} for req-${rid}`;
  }
}

/**
 * Dedupe guard: checks if we already recorded this Vercel event id for the
 * same site. Uses the JSONB `contains` operator (`@>`) on `details`. Cheap
 * enough at our volume that we do not need a dedicated unique index.
 */
async function isDuplicateEvent(params: {
  siteId: string;
  rawEventId: string;
}): Promise<boolean> {
  const { siteId, rawEventId } = params;
  if (!siteId || !rawEventId) return false;

  const { data, error } = await supabaseAdmin
    .from('instance_logs')
    .select('id')
    .eq('site_id', siteId)
    .eq('log_type', 'infrastructure')
    .contains('details', { raw_event_id: rawEventId })
    .limit(1);

  if (error) {
    console.warn('[VercelWebhook] dedupe lookup failed:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

export interface HandleVercelWebhookOptions {
  /** Override resolver (test hook). */
  resolveContext?: (payload: VercelWebhookPayloadBody | undefined) => Promise<ResolvedVercelContext>;
}

/**
 * Processes a verified Vercel webhook event. Returns an outcome object the
 * route handler can surface in its JSON response.
 */
export async function handleVercelWebhookEvent(
  event: VercelWebhookEvent,
  options: HandleVercelWebhookOptions = {},
): Promise<VercelWebhookOutcome> {
  if (!isVercelDeploymentEventType(event.type)) {
    return { status: 'ignored', event: event.type, reason: 'non-deployment-event' };
  }

  const resolver = options.resolveContext ?? resolveVercelContext;
  const ctx = await resolver(event.payload);

  if (ctx.isProductionBranch) {
    return { status: 'ignored', event: event.type, reason: 'production-branch' };
  }
  if (!ctx.requirementId) {
    return { status: 'ignored', event: event.type, reason: 'no-requirement-branch' };
  }
  if (!ctx.siteId) {
    // We have a requirement branch but no requirement_status yet (e.g. first
    // deploy before the cron runs). Skip without retry — the next cron tick
    // will persist its own logs anyway.
    return { status: 'ignored', event: event.type, reason: 'no-site-for-requirement' };
  }

  const mapped = mapEventTypeToInfra(event.type);
  if (!mapped) {
    return { status: 'ignored', event: event.type, reason: 'unmapped-event' };
  }

  const previewUrl = buildPreviewUrl(event.payload.deployment?.url);
  const duplicate = await isDuplicateEvent({ siteId: ctx.siteId, rawEventId: event.id });
  if (duplicate) {
    return { status: 'deduped', event: event.type, requirementId: ctx.requirementId };
  }

  const auditCtx: CronAuditContext = {
    siteId: ctx.siteId,
    instanceId: ctx.instanceId ?? undefined,
    requirementId: ctx.requirementId,
  };

  await logCronInfrastructureEvent(auditCtx, {
    event: CronInfraEvent[mapped.key],
    level: mapped.level,
    message: buildLogMessage(event, ctx, previewUrl),
    details: buildLogDetails(event, ctx, previewUrl),
  });

  let updatedPreview = false;
  if (mapped.key === 'VERCEL_WEBHOOK_DEPLOYMENT_READY' && previewUrl) {
    try {
      const res = await patchLatestRequirementStatusColumns({
        requirementId: ctx.requirementId,
        siteId: ctx.siteId,
        instanceId: ctx.instanceId ?? undefined,
        columns: { preview_url: previewUrl },
      });
      updatedPreview = Boolean(res.updated);
    } catch (e: unknown) {
      // Never let a status write failure tank the webhook ack — Vercel would
      // retry forever. We already captured the ready event in instance_logs.
      console.warn(
        '[VercelWebhook] patchLatestRequirementStatusColumns failed:',
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    status: 'processed',
    event: event.type,
    requirementId: ctx.requirementId,
    updatedPreview,
  };
}
