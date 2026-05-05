/**
 * Resolves Vercel webhook payloads to our internal identifiers (requirement,
 * site, instance) without touching new tables. All lookups go through the
 * existing `requirement_status` pipeline so the webhook hits the same code
 * paths as the cron.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { extractRequirementIdFromBranch } from '@/lib/services/requirement-branch';
import type { GitRepoKind } from '@/app/api/cron/shared/cron-commit-helpers';
import type { VercelWebhookPayloadBody } from './webhook-types';

export interface ResolvedVercelContext {
  /** Branch extracted from the payload (may be null when meta is missing). */
  branch: string | null;
  /** Requirement UUID decoded from the branch, or null for production/main branches. */
  requirementId: string | null;
  /** Owning site (from latest requirement_status row). */
  siteId: string | null;
  /** Last known robot_instance id for the requirement (may be null). */
  instanceId: string | null;
  /** Whether the deployment belongs to the apps repo or the automations repo. */
  gitRepoKind: GitRepoKind;
  /** True when the branch looks like a production/main branch (not a requirement). */
  isProductionBranch: boolean;
}

const PRODUCTION_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'production']);

/** Pulls the branch name out of the deployment meta, tolerating missing fields. */
export function extractBranchFromPayload(payload: VercelWebhookPayloadBody | undefined): string | null {
  const meta = payload?.deployment?.meta;
  if (!meta) return null;
  const candidates = [
    meta.githubCommitRef,
    meta.gitlabProjectPath,
    meta.bitbucketRepoName,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return candidates[0] ?? null;
}

/**
 * Classifies the deployment as `applications` or `automation` based on (in order):
 *   1. Project id match against `VERCEL_PROJECT_ID` (for applications) / `VERCEL_PROJECT_ID_AUTOMATION`
 *   2. GitHub repo name match against `GIT_APPLICATIONS_REPO` / `GIT_AUTOMATIONS_REPO`
 *   3. Fallback: `applications` (the default side of the product).
 */
export function classifyGitRepoKind(payload: VercelWebhookPayloadBody | undefined): GitRepoKind {
  const projectId = payload?.projectId || payload?.project?.id || null;
  const appsProject = process.env.VERCEL_PROJECT_ID?.trim();
  const autoProject = process.env.VERCEL_PROJECT_ID_AUTOMATION?.trim();

  if (projectId && appsProject && projectId === appsProject) return 'applications';
  if (projectId && autoProject && projectId === autoProject) return 'automation';

  const repoName = payload?.deployment?.meta?.githubRepo || null;
  const appsRepo = process.env.GIT_APPLICATIONS_REPO?.trim() || 'apps';
  const autoRepo = process.env.GIT_AUTOMATIONS_REPO?.trim() || 'automations';

  if (repoName && autoRepo && repoName === autoRepo) return 'automation';
  if (repoName && appsRepo && repoName === appsRepo) return 'applications';

  return 'applications';
}

/** Lowercases the branch and returns true if it is a shared production branch. */
export function isProductionBranch(branch: string | null | undefined): boolean {
  if (!branch) return false;
  return PRODUCTION_BRANCHES.has(String(branch).trim().toLowerCase());
}

/**
 * Resolves `site_id` + `instance_id` by reading the latest `requirement_status`
 * row for the requirement. Mirrors the pattern used in
 * `src/app/api/cron/requirements-automations/route.ts`.
 */
async function loadLatestRequirementContext(requirementId: string): Promise<{
  siteId: string | null;
  instanceId: string | null;
}> {
  const { data, error } = await supabaseAdmin
    .from('requirement_status')
    .select('site_id, instance_id, created_at')
    .eq('requirement_id', requirementId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.warn('[VercelWebhook] requirement_status lookup failed:', error.message);
    return { siteId: null, instanceId: null };
  }

  const row = data?.[0] as { site_id?: string | null; instance_id?: string | null } | undefined;
  return {
    siteId: row?.site_id ?? null,
    instanceId: row?.instance_id ?? null,
  };
}

/**
 * Turns a Vercel webhook payload into our internal context. Never throws —
 * returns nulls for missing fields so callers can decide to skip or log.
 */
export async function resolveVercelContext(
  payload: VercelWebhookPayloadBody | undefined,
): Promise<ResolvedVercelContext> {
  const branch = extractBranchFromPayload(payload);
  const gitRepoKind = classifyGitRepoKind(payload);
  const production = isProductionBranch(branch);
  const requirementId = !production ? extractRequirementIdFromBranch(branch) : null;

  if (!requirementId) {
    return {
      branch,
      requirementId: null,
      siteId: null,
      instanceId: null,
      gitRepoKind,
      isProductionBranch: production,
    };
  }

  const { siteId, instanceId } = await loadLatestRequirementContext(requirementId);
  return {
    branch,
    requirementId,
    siteId,
    instanceId,
    gitRepoKind,
    isProductionBranch: false,
  };
}
