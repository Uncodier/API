import { supabaseAdmin } from '@/lib/database/supabase-client';
import { parseGithubTreeUrl, branchBelongsToRequirement } from '@/lib/services/requirement-branch';
import { getRequirementGitBinding } from '@/lib/services/requirement-git-binding';

/**
 * Pure (next/server-free) implementation of the requirement_status tool core.
 *
 * Why this lives under `src/lib/tools/` instead of next to the route file:
 * the Next.js route at `src/app/api/agents/tools/requirement_status/route.ts`
 * imports `next/server`, which transitively pulls in `ua-parser-js` and uses
 * `__dirname`. When a Vercel Workflow bundle (`'use workflow'` / `'use step'`)
 * imports any file that sits next to that route, the Turbopack/Next.js bundler
 * co-bundles the sibling `route.ts` into the workflow graph and we hit a
 * `ReferenceError: __dirname is not defined` at init time inside the
 * Edge-like workflow runtime.
 *
 * Keeping the shared logic outside the `app/` tree guarantees that workflow
 * modules (cron commit helpers, cron-workflow-finalize, etc.) can consume the
 * same implementation as the HTTP route without dragging `next/server` in.
 *
 * IMPORTANT: keep this module free of any `next/server`, `next/headers`, or
 * other Next.js runtime imports.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks that repo_url belongs to the requirement (org/repo match
 * metadata.git and branch encodes the requirement UUID). Returns a short
 * reason when inconsistent, `null` when OK or when no repo_url was provided.
 */
async function checkRepoUrlMatchesRequirement(
  requirementId: string,
  repoUrl: string | undefined,
): Promise<string | null> {
  if (!repoUrl) return null;
  const parsed = parseGithubTreeUrl(repoUrl);
  if (!parsed) return 'repo_url is not a github tree URL';
  const binding = await getRequirementGitBinding(requirementId).catch(() => null);
  if (binding) {
    if (binding.org.toLowerCase() !== parsed.org.toLowerCase()) {
      return `repo_url org "${parsed.org}" does not match metadata.git.org "${binding.org}"`;
    }
    if (binding.repo.toLowerCase() !== parsed.repo.toLowerCase()) {
      return `repo_url repo "${parsed.repo}" does not match metadata.git.repo "${binding.repo}"`;
    }
  }
  if (!branchBelongsToRequirement(parsed.branch, requirementId)) {
    return `branch "${parsed.branch}" does not encode requirement ${requirementId}`;
  }
  return null;
}

export async function createRequirementStatusCore(params: {
  site_id: string;
  instance_id?: string;
  asset_id?: string;
  requirement_id: string;
  repo_url?: string;
  preview_url?: string;
  source_code?: string;
  snapshot_id?: string;
  active_sandbox_id?: string;
  status?: string;
  message?: string;
  cycle?: string;
  endpoint_url?: string;
}) {
  const {
    site_id,
    instance_id,
    asset_id,
    requirement_id,
    repo_url,
    preview_url,
    source_code,
    snapshot_id,
    active_sandbox_id,
    status,
    message,
    cycle,
    endpoint_url,
  } = params;

  if (!site_id || !requirement_id || !status) {
    throw new Error('site_id, requirement_id, and status are required');
  }

  // Deliverable gate: done only with repo_url, preview or endpoint, and source archive URL.
  const hasRepo = !!repo_url;
  const hasEndpoint = !!(preview_url || endpoint_url);
  const hasSourceArchive = !!source_code?.trim();
  let effectiveStatus = status;
  const missing: string[] = [];
  if (!hasRepo) missing.push('repo_url');
  if (!hasEndpoint) missing.push('preview_url/endpoint_url');
  if (!hasSourceArchive) missing.push('source_code');

  // Consistency gate: repo_url must match requirement.metadata.git + branch
  // must encode the requirement UUID. Advisory unless REQUIREMENT_GIT_STRICT=true.
  const strict = process.env.REQUIREMENT_GIT_STRICT === 'true';
  const consistencyErr = await checkRepoUrlMatchesRequirement(requirement_id, repo_url);
  if (consistencyErr) {
    console.warn(
      `[RequirementStatus] repo_url inconsistency for req ${requirement_id}: ${consistencyErr}${strict ? ' (STRICT — downgrade)' : ' (advisory)'}`,
    );
    if (strict) missing.push(`git_consistency: ${consistencyErr}`);
  }

  if ((status === 'done' || status === 'completed') && missing.length > 0) {
    console.warn(
      `[RequirementStatus] Downgrading "${status}" → "in-progress" for req ${requirement_id} — missing: ${missing.join(', ')}`,
    );
    effectiveStatus = 'in-progress';
  }

  const validAssetId = asset_id && UUID_RE.test(asset_id) ? asset_id : null;
  const validInstanceId = instance_id && UUID_RE.test(instance_id) ? instance_id : null;

  // Find the current active_sandbox_id to carry it over to the new status row
  const { data: currentStatus } = await supabaseAdmin
    .from('requirement_status')
    .select('active_sandbox_id')
    .eq('requirement_id', requirement_id)
    .eq('instance_id', validInstanceId)
    .not('active_sandbox_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabaseAdmin
    .from('requirement_status')
    .insert([
      {
        site_id,
        instance_id: validInstanceId,
        asset_id: validAssetId,
        requirement_id,
        repo_url: repo_url || null,
        preview_url: preview_url || null,
        source_code: source_code || null,
        snapshot_id: snapshot_id?.trim() || null,
        active_sandbox_id: active_sandbox_id || currentStatus?.active_sandbox_id || null,
        status: effectiveStatus,
        message: message || null,
        cycle: cycle || null,
        endpoint_url: endpoint_url || null,
        created_at: new Date().toISOString(),
      },
    ])
    .select()
    .single();

  if (error) {
    throw new Error(`Error inserting requirement status: ${error.message}`);
  }

  if (effectiveStatus === 'completed' || effectiveStatus === 'done' || effectiveStatus === 'in-progress') {
    const mappedStatus = effectiveStatus === 'in-progress' ? 'in-progress' : 'done';
    await supabaseAdmin
      .from('requirements')
      .update({ status: mappedStatus, updated_at: new Date().toISOString() })
      .eq('id', requirement_id);
  }

  return { success: true, data };
}

export async function listRequirementStatusCore(params: {
  requirement_id: string;
  instance_id?: string;
}) {
  const { requirement_id, instance_id } = params;

  let query = supabaseAdmin.from('requirement_status').select('*');

  if (requirement_id) {
    query = query.eq('requirement_id', requirement_id);
  }
  const validInstanceId = instance_id && UUID_RE.test(instance_id) ? instance_id : null;

  if (validInstanceId) {
    query = query.eq('instance_id', validInstanceId);
  }

  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;

  if (error) {
    throw new Error(`Error getting requirement status: ${error.message}`);
  }

  return { success: true, data };
}
