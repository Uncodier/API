/**
 * Fetches Vercel deployment build logs via REST API (Bearer token) for cron audit / gate errors.
 *
 * Env (optional — if missing, helpers no-op):
 * - VERCEL_TOKEN or VERCEL_ACCESS_TOKEN
 * - VERCEL_TEAM_ID — team scope (required for team-owned projects)
 * - VERCEL_PROJECT_ID — default project
 * - VERCEL_PROJECT_ID_APPLICATIONS / VERCEL_PROJECT_ID_AUTOMATION — override per repo kind
 */

import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import type { GitRepoKind } from '@/app/api/cron/shared/cron-commit-helpers';

const VERCEL_API = 'https://api.vercel.com';

function getVercelToken(): string | null {
  const t = process.env.VERCEL_TOKEN || process.env.VERCEL_ACCESS_TOKEN;
  return t?.trim() || null;
}

export function resolveVercelProjectId(kind: GitRepoKind): string | null {
  const fallback = process.env.VERCEL_PROJECT_ID?.trim();
  if (kind === 'automation') {
    const p = process.env.VERCEL_PROJECT_ID_AUTOMATION?.trim();
    return p || fallback || null;
  }
  const p = process.env.VERCEL_PROJECT_ID_APPLICATIONS?.trim();
  return p || fallback || null;
}

function eventsQueryString(): string {
  const qs = new URLSearchParams({ limit: '-1' });
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  if (teamId) qs.set('teamId', teamId);
  return qs.toString();
}

type VercelDeploymentRow = { uid?: string; inspectorUrl?: string; url?: string | null };

async function findDeploymentUidForSha(
  sha: string,
  projectId: string,
  token: string,
): Promise<{ uid: string; inspectorUrl?: string } | null> {
  const qs = new URLSearchParams({
    sha,
    projectId,
    limit: '10',
  });
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  if (teamId) qs.set('teamId', teamId);

  const res = await fetch(`${VERCEL_API}/v6/deployments?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.warn(`[VercelLogs] list deployments HTTP ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { deployments?: VercelDeploymentRow[] };
  const list = data.deployments;
  if (!Array.isArray(list) || list.length === 0) return null;
  const dep = list[0];
  const uid = dep?.uid;
  if (!uid) return null;
  return { uid, inspectorUrl: dep?.inspectorUrl };
}

function flattenEventToLine(ev: unknown): string | null {
  if (!ev || typeof ev !== 'object') return null;
  const o = ev as Record<string, unknown>;
  const typ = String(o.type || 'event');
  const payload = o.payload as Record<string, unknown> | undefined;
  const text =
    (typeof payload?.text === 'string' && payload.text) ||
    (typeof o.text === 'string' && o.text) ||
    '';
  if (text.trim()) {
    return `[${typ}] ${text}`;
  }
  if (typ === 'fatal' && payload && typeof (payload as { text?: string }).text === 'string') {
    return `[fatal] ${(payload as { text: string }).text}`;
  }
  if (typ === 'command' && payload?.info && typeof payload.info === 'object') {
    const info = payload.info as { name?: string; path?: string };
    const hint = info.name || info.path || '';
    if (hint) return `[command] ${hint}`;
  }
  if (typ === 'deployment-state' && payload?.readyState) {
    return `[deployment-state] ${String(payload.readyState)}`;
  }
  return null;
}

/**
 * Returns concatenated build log text from /v3/deployments/{uid}/events (stdout/stderr/command lines).
 */
export async function fetchVercelBuildLogText(deploymentUid: string, token: string): Promise<string> {
  const url = `${VERCEL_API}/v3/deployments/${encodeURIComponent(deploymentUid)}/events?${eventsQueryString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.warn(`[VercelLogs] events HTTP ${res.status} for ${deploymentUid.slice(0, 8)}…`);
    return '';
  }
  const raw = await res.text();
  let events: unknown;
  try {
    events = JSON.parse(raw);
  } catch {
    console.warn('[VercelLogs] events response is not JSON');
    return '';
  }
  if (!Array.isArray(events)) {
    return '';
  }
  const lines: string[] = [];
  for (const ev of events) {
    const line = flattenEventToLine(ev);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

export type VercelBuildLogResult = {
  /** Truncated excerpt for DB / agent messages */
  excerpt: string;
  deploymentUid: string;
  inspectorUrl?: string;
};

const MAX_EXCERPT = 14_000;

/**
 * Resolves deployment by git SHA + project, fetches build events, returns truncated excerpt.
 */
export async function fetchVercelBuildLogForSha(
  sha: string,
  gitRepoKind: GitRepoKind,
): Promise<VercelBuildLogResult | null> {
  const token = getVercelToken();
  const projectId = resolveVercelProjectId(gitRepoKind);
  if (!token || !projectId) {
    return null;
  }

  const dep = await findDeploymentUidForSha(sha, projectId, token);
  if (!dep) {
    return null;
  }

  const full = await fetchVercelBuildLogText(dep.uid, token);
  const excerpt = full.length > MAX_EXCERPT ? `…(truncated)\n${full.slice(-MAX_EXCERPT)}` : full;

  return {
    excerpt: excerpt || '(no stdout/stderr lines in deployment events)',
    deploymentUid: dep.uid,
    inspectorUrl: dep.inspectorUrl,
  };
}

/**
 * Fetches Vercel build log for the commit and persists to instance_logs (when audit.siteId is set).
 * Returns excerpt text for appending to gate errors (or null if skipped / unavailable).
 */
export async function fetchAndLogVercelBuildLog(
  audit: CronAuditContext | undefined,
  input: {
    sha: string;
    branch: string;
    stepOrder: number;
    gitRepoKind: GitRepoKind;
    outcome: 'success' | 'failure' | 'timeout';
  },
): Promise<string | null> {
  const result = await fetchVercelBuildLogForSha(input.sha, input.gitRepoKind);
  if (!result) {
    return null;
  }

  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.VERCEL_BUILD_LOG,
    level: input.outcome === 'success' ? 'info' : 'error',
    message: `Vercel build log (step ${input.stepOrder}, ${input.sha.slice(0, 7)}, ${input.outcome})`,
    details: {
      branch: input.branch,
      sha: input.sha.slice(0, 12),
      deployment_uid: result.deploymentUid,
      inspector_url: result.inspectorUrl ?? null,
      outcome: input.outcome,
      log_excerpt: result.excerpt.slice(0, 12_000),
      source: 'vercel_api',
    },
  });

  return result.excerpt;
}
