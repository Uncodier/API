/**
 * Resolves Vercel preview URL for a Git branch via GitHub APIs (deployments + check-runs fallback),
 * optional Vercel REST fallback when GitHub deployment records lag behind Vercel.
 */

import {
  fetchGitHubBranchTipSha,
  pollGitHubDeploymentForSha,
  tryCheckRunsPreviewUrl,
} from '@/lib/services/github-deployment-status';

export {
  fetchGitHubBranchTipSha,
  pollGitHubDeploymentForSha,
  tryCheckRunsPreviewUrl,
} from '@/lib/services/github-deployment-status';

export type PreviewUrlGitRepoKind = 'applications' | 'automation';

function resolveVercelProjectIdForPreview(kind: PreviewUrlGitRepoKind): string | null {
  const fallback = process.env.VERCEL_PROJECT_ID?.trim();
  if (kind === 'automation') {
    return process.env.VERCEL_PROJECT_ID_AUTOMATION?.trim() || fallback || null;
  }
  return fallback || null;
}

/**
 * When GitHub statuses are still "pending" but Vercel already created a deployment for the SHA.
 * Avoids importing vercel-build-logs (would cycle with cron-commit-helpers → sandbox-service).
 */
async function tryVercelRestPreviewForSha(
  sha: string,
  gitRepoKind: PreviewUrlGitRepoKind,
): Promise<string | null> {
  const token = (process.env.VERCEL_TOKEN || process.env.VERCEL_ACCESS_TOKEN)?.trim();
  const projectId = resolveVercelProjectIdForPreview(gitRepoKind);
  if (!token || !projectId) return null;

  const qs = new URLSearchParams({ sha, projectId, limit: '5' });
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  if (teamId) qs.set('teamId', teamId);

  try {
    const res = await fetch(`https://api.vercel.com/v6/deployments?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { deployments?: Array<{ url?: string | null }> };
    const dep = data.deployments?.[0];
    const host = dep?.url;
    if (!host || typeof host !== 'string') return null;
    const u = host.startsWith('http') ? host : `https://${host}`;
    console.log(`[DeployPoll] Vercel REST list-deployments URL for ${sha.slice(0, 12)}: ${u}`);
    return u;
  } catch (e: unknown) {
    console.warn('[DeployPoll] Vercel REST preview failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function getGitHubBranchPreviewUrl(
  owner: string,
  repo: string,
  branch: string,
  maxAttempts = 20,
  pollIntervalMs = 5000,
  gitRepoKind?: PreviewUrlGitRepoKind,
): Promise<string | null> {
  const sha = await fetchGitHubBranchTipSha(owner, repo, branch);
  if (!sha) return null;

  const poll = await pollGitHubDeploymentForSha(owner, repo, sha, { maxAttempts, pollIntervalMs });
  if (poll.state === 'success' && poll.previewUrl) {
    return poll.previewUrl;
  }
  if (poll.state === 'failure' || poll.state === 'error') {
    return null;
  }

  const fromChecks = await tryCheckRunsPreviewUrl(owner, repo, sha);
  if (fromChecks) return fromChecks;

  if (gitRepoKind) {
    const fromVercel = await tryVercelRestPreviewForSha(sha, gitRepoKind);
    if (fromVercel) return fromVercel;
  }

  return null;
}
