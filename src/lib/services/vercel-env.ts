import { resolveVercelProjectId } from './vercel-build-logs';

const VERCEL_API = 'https://api.vercel.com';

function getVercelToken(): string | null {
  const t = process.env.VERCEL_TOKEN || process.env.VERCEL_ACCESS_TOKEN;
  return t?.trim() || null;
}

export async function pushVercelBranchEnv(
  branch: string,
  envVars: Record<string, string>,
  gitRepoKind: 'applications' | 'automation' = 'applications'
) {
  const token = getVercelToken();
  const projectId = resolveVercelProjectId(gitRepoKind);

  if (!token || !projectId) {
    console.warn('[VercelEnv] Missing VERCEL_TOKEN or VERCEL_PROJECT_ID, skipping Vercel Env sync.');
    return;
  }

  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  const qs = teamId ? `?teamId=${teamId}` : '';

  try {
    // 1. Fetch existing env vars for this branch
    const listRes = await fetch(`${VERCEL_API}/v9/projects/${projectId}/env${qs ? qs + '&' : '?'}gitBranch=${encodeURIComponent(branch)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!listRes.ok) {
      console.warn(`[VercelEnv] Failed to list env vars: HTTP ${listRes.status}`);
      return;
    }

    const data = await listRes.json() as { envs?: Array<{ id: string; key: string; value: string; target: string[]; gitBranch?: string }> };
    const existingEnvs = data.envs || [];

    for (const [key, value] of Object.entries(envVars)) {
      if (!value) continue;

      const existing = existingEnvs.find(e => e.key === key && e.gitBranch === branch);

      if (existing) {
        if (existing.value === value) {
          console.log(`[VercelEnv] Env var ${key} already exists with same value for branch ${branch}, skipping update.`);
          continue;
        }

        // Update
        const patchRes = await fetch(`${VERCEL_API}/v9/projects/${projectId}/env/${existing.id}${qs}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            value,
            target: ['preview'],
            type: 'plain',
            gitBranch: branch
          })
        });
        if (!patchRes.ok) {
          console.warn(`[VercelEnv] Failed to update env var ${key}: HTTP ${patchRes.status}`);
        } else {
          console.log(`[VercelEnv] Updated ${key} for branch ${branch}`);
        }
      } else {
        // Create
        const postRes = await fetch(`${VERCEL_API}/v10/projects/${projectId}/env${qs}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            key,
            value,
            target: ['preview'],
            type: 'plain',
            gitBranch: branch
          })
        });
        if (!postRes.ok) {
          console.warn(`[VercelEnv] Failed to create env var ${key}: HTTP ${postRes.status}`);
        } else {
          console.log(`[VercelEnv] Created ${key} for branch ${branch}`);
        }
      }
    }
  } catch (e: unknown) {
    console.warn('[VercelEnv] Vercel API error:', e instanceof Error ? e.message : String(e));
  }
}