/**
 * GitHub Deployments + statuses (Vercel and other integrations post here).
 * Used for preview URLs and terminal deploy success/failure for gates.
 */

export type GitHubDeployPollState = 'success' | 'failure' | 'error' | 'pending';

export type GitHubDeployPollResult = {
  state: GitHubDeployPollState;
  previewUrl: string | null;
  detail?: string;
  /**
   * Vercel deployment id (dpl_*) parsed from the GitHub deployment status (description
   * or target_url). When present, callers can fetch build logs directly via the Vercel
   * REST API without needing VERCEL_PROJECT_ID — which is the reliable path because
   * GitHub already proved the deployment exists.
   */
  vercelDeploymentId?: string | null;
};

const VERCEL_DPL_REGEX = /\bdpl_[A-Za-z0-9]+/;

/**
 * Best-effort parse of a Vercel deployment id from a GitHub deployment status.
 * Vercel's GitHub integration writes the dpl_* into both `description` (CLI hint) and
 * `target_url` (vercel.com inspector link), so we check both.
 */
export function extractVercelDeploymentId(status: {
  description?: string | null;
  target_url?: string | null;
}): string | null {
  const fromDescription = status.description ? status.description.match(VERCEL_DPL_REGEX) : null;
  if (fromDescription?.[0]) return fromDescription[0];
  const fromTarget = status.target_url ? status.target_url.match(VERCEL_DPL_REGEX) : null;
  if (fromTarget?.[0]) return fromTarget[0];
  return null;
}

function authHeaders(): HeadersInit {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) throw new Error('GITHUB_TOKEN is required');
  return {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * Resolves the commit SHA at the tip of a branch on GitHub.
 */
export async function fetchGitHubBranchTipSha(
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  try {
    const branchRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
      { headers: authHeaders() },
    );
    if (!branchRes.ok) {
      console.warn(`[DeployPoll] Could not resolve branch ${branch}: HTTP ${branchRes.status}`);
      return null;
    }
    const branchData = await branchRes.json();
    const sha = branchData.commit?.sha || null;
    if (sha) {
      console.log(`[DeployPoll] Branch ${branch} HEAD SHA: ${sha.substring(0, 12)}`);
    }
    return sha;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[DeployPoll] Error resolving branch SHA: ${msg}`);
    return null;
  }
}

type GhDeploymentStatus = {
  id?: number;
  state?: string;
  environment_url?: string | null;
  description?: string | null;
  target_url?: string | null;
};

/** GitHub usually returns newest-first; sort by id desc to pick the latest status reliably. */
function sortStatusesNewestFirst(statuses: GhDeploymentStatus[]): GhDeploymentStatus[] {
  return [...statuses].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
}

/** Expects statuses sorted newest-first (e.g. via sortStatusesNewestFirst). */
function classifyLatestDeploymentStatus(sortedNewestFirst: GhDeploymentStatus[]): 'ok' | 'bad' | 'wait' {
  if (!sortedNewestFirst.length) return 'wait';
  const latest = sortedNewestFirst[0];
  const s = (latest.state || '').toLowerCase();
  if (s === 'success') {
    if (latest.environment_url) return 'ok';
    return 'wait';
  }
  if (s === 'failure' || s === 'error') return 'bad';
  return 'wait';
}

/**
 * Polls GitHub deployments for a commit SHA until a terminal success (with preview URL),
 * terminal failure/error, or timeout.
 */
export async function pollGitHubDeploymentForSha(
  owner: string,
  repo: string,
  sha: string,
  options?: { maxAttempts?: number; pollIntervalMs?: number },
): Promise<GitHubDeployPollResult> {
  const maxAttempts = options?.maxAttempts ?? 24;
  const pollIntervalMs = options?.pollIntervalMs ?? 5000;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/deployments?ref=${encodeURIComponent(sha)}&per_page=10`,
        { headers: authHeaders() },
      );
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }

      const rawDeployments = await res.json();
      const deployments: { id: number; statuses_url: string; created_at?: string }[] = Array.isArray(
        rawDeployments,
      )
        ? rawDeployments
        : [];
      if (!deployments.length) {
        console.log(`[DeployPoll] No deployments yet for ${sha.slice(0, 12)} (attempt ${i + 1}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }

      deployments.sort((a, b) => {
        const ta = a.created_at ? Date.parse(a.created_at) : 0;
        const tb = b.created_at ? Date.parse(b.created_at) : 0;
        return tb - ta;
      });

      const dep = deployments[0];
      const statusesRes = await fetch(dep.statuses_url, { headers: authHeaders() });
      if (statusesRes.ok) {
        const raw: GhDeploymentStatus[] = await statusesRes.json();
        const statuses = sortStatusesNewestFirst(Array.isArray(raw) ? raw : []);
        const latest = classifyLatestDeploymentStatus(statuses);
        const newest = statuses[0];
        if (latest === 'bad') {
          const st = (newest?.state || 'error').toLowerCase();
          return {
            state: st === 'failure' ? 'failure' : 'error',
            previewUrl: newest?.environment_url || null,
            detail: newest?.description || `deployment status: ${newest?.state}`,
            vercelDeploymentId: newest ? extractVercelDeploymentId(newest) : null,
          };
        }
        if (latest === 'ok' && newest?.environment_url) {
          console.log(`[DeployPoll] Success: ${newest.environment_url}`);
          return {
            state: 'success',
            previewUrl: newest.environment_url,
            vercelDeploymentId: extractVercelDeploymentId(newest),
          };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[DeployPoll] Poll error: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return {
    state: 'pending',
    previewUrl: null,
    detail: `timeout after ${maxAttempts} attempts (${(maxAttempts * pollIntervalMs) / 1000}s) waiting for GitHub deployment for ${sha.slice(0, 12)}`,
  };
}

/**
 * Fallback: parse Vercel preview hostname from check-run output (no terminal failure signal).
 */
export async function tryCheckRunsPreviewUrl(
  owner: string,
  repo: string,
  sha: string,
): Promise<string | null> {
  try {
    const checkRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs`,
      { headers: authHeaders() },
    );
    if (!checkRes.ok) return null;
    const checkData = await checkRes.json();
    for (const cr of checkData.check_runs || []) {
      const summary = cr.output?.summary || '';
      const match = summary.match(/([a-z0-9-]+-[a-z0-9-]+\.vercel\.app)/);
      if (match) {
        const url = `https://${match[1]}`;
        console.log(`[DeployPoll] Check-run summary URL: ${url}`);
        return url;
      }
    }
  } catch (err: unknown) {
    console.warn('[DeployPoll] check-runs fallback failed:', err instanceof Error ? err.message : err);
  }
  return null;
}
