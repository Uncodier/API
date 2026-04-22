import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createRequirementStatusCore } from '@/app/api/agents/tools/requirement_status/route';
import { logInstancePreviewUrlRecorded } from '@/lib/services/cron-audit-log';
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  getRequirementGitBinding,
  resolveDefaultGitBinding,
  gitBindingBranchTreeUrl,
  instanceTypeFromGitKind,
  type GitBinding,
  type GitBindingKind,
} from '@/lib/services/requirement-git-binding';
import { branchBelongsToRequirement } from '@/lib/services/requirement-branch';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GitRepoKind = 'applications' | 'automation';

/**
 * @deprecated Prefer `resolveGitBindingForRequirement`.
 */
export function repoNameForGitRepoKind(gitRepoKind: GitRepoKind = 'applications'): string {
  return gitRepoKind === 'automation'
    ? process.env.GIT_AUTOMATIONS_REPO || 'automations'
    : process.env.GIT_APPLICATIONS_REPO || 'apps';
}

export async function resolveGitBindingForRequirement(
  requirementId: string,
  gitRepoKind: GitRepoKind = 'applications',
): Promise<GitBinding> {
  const instanceType = instanceTypeFromGitKind(gitRepoKind as GitBindingKind);
  try {
    return await getRequirementGitBinding(requirementId, instanceType);
  } catch {
    return resolveDefaultGitBinding(instanceType);
  }
}

export async function resolveSiteIdForRequirementStatus(params: {
  requirementId: string;
  siteId?: string;
  instanceId?: string;
}): Promise<string | null> {
  if (params.siteId?.trim()) {
    return params.siteId.trim();
  }
  const { data: req } = await supabaseAdmin
    .from('requirements')
    .select('site_id')
    .eq('id', params.requirementId)
    .maybeSingle();
  if (req?.site_id) {
    return req.site_id;
  }
  const iid = params.instanceId?.trim();
  if (iid && UUID_RE.test(iid)) {
    const { data: robot } = await supabaseAdmin
      .from('robot_instances')
      .select('site_id')
      .eq('id', iid)
      .maybeSingle();
    if (robot?.site_id) {
      return robot.site_id;
    }
    const { data: remote } = await supabaseAdmin
      .from('remote_instances')
      .select('site_id')
      .eq('id', iid)
      .maybeSingle();
    if (remote?.site_id) {
      return remote.site_id;
    }
  }
  return null;
}

export async function syncLatestRequirementStatusWithPreview(params: {
  requirementId: string;
  branch: string;
  siteId?: string;
  instanceId?: string;
  gitRepoKind?: GitRepoKind;
  gitBinding?: GitBinding;
  preview_url_resolved?: string | null;
  use_resolved_preview_only?: boolean;
  persist?: boolean;
}): Promise<{ updated: boolean; preview_url: string | null; repo_url: string }> {
  const {
    requirementId,
    branch,
    siteId,
    instanceId,
    gitRepoKind = 'applications',
    gitBinding,
    preview_url_resolved,
    use_resolved_preview_only,
    persist = true,
  } = params;
  const binding = gitBinding ?? (await resolveGitBindingForRequirement(requirementId, gitRepoKind));
  const repo_url = gitBindingBranchTreeUrl(binding, branch);

  if (branch && !branchBelongsToRequirement(branch, requirementId)) {
    console.warn(
      `[RequirementStatusSync] Branch "${branch}" does not encode requirement "${requirementId}" (non-canonical). Sync will still write repo_url but validation may reject this pair.`,
    );
  }

  const kindForPreview: GitRepoKind = binding.kind === 'automation' ? 'automation' : 'applications';
  let preview_url: string | null = null;
  if (use_resolved_preview_only) {
    preview_url = preview_url_resolved ?? null;
  } else if (branch && branch !== binding.default_branch && branch !== 'main' && branch !== 'master') {
    try {
      preview_url = await SandboxService.getPreviewUrl(binding.org, binding.repo, branch, 20, 5000, kindForPreview);
    } catch (e: unknown) {
      console.warn('[RequirementStatusSync] getPreviewUrl failed:', e instanceof Error ? e.message : e);
    }
  }

  const resolvedSiteId = await resolveSiteIdForRequirementStatus({
    requirementId,
    siteId,
    instanceId,
  });

  if (!resolvedSiteId) {
    console.warn('[RequirementStatusSync] No site_id; skip DB update for', requirementId);
    return { updated: false, preview_url, repo_url };
  }

  if (!persist) {
    return { updated: false, preview_url, repo_url };
  }

  let q = supabaseAdmin
    .from('requirement_status')
    .select('id')
    .eq('requirement_id', requirementId)
    .order('created_at', { ascending: false })
    .limit(1);

  const validInstance = instanceId && UUID_RE.test(instanceId) ? instanceId : null;
  if (validInstance) {
    q = q.eq('instance_id', validInstance);
  }

  const { data: rows, error: selErr } = await q;
  if (selErr) {
    console.warn('[RequirementStatusSync] Select failed:', selErr.message);
    return { updated: false, preview_url, repo_url };
  }

  const rowId = rows?.[0]?.id;
  if (!rowId) {
    console.warn('[RequirementStatusSync] No requirement_status row to update for', requirementId);
    return { updated: false, preview_url, repo_url };
  }

  const patch: Record<string, string> = {
    repo_url,
    updated_at: new Date().toISOString(),
  };
  if (preview_url !== null && preview_url !== '') {
    patch.preview_url = preview_url;
  }

  const { error: upErr } = await supabaseAdmin.from('requirement_status').update(patch).eq('id', rowId);
  if (upErr) {
    console.warn('[RequirementStatusSync] Update failed:', upErr.message);
    return { updated: false, preview_url, repo_url };
  }

  if (preview_url) {
    await logInstancePreviewUrlRecorded({
      siteId: resolvedSiteId,
      instanceId: validInstance ?? instanceId ?? null,
      requirementId,
      previewUrl: preview_url,
      context: 'requirement_status_sync',
      repoUrl: repo_url,
    });
  }

  console.log(`[RequirementStatusSync] Updated ${rowId} (repo_url${preview_url !== null ? ' + preview_url' : ''})`);
  return { updated: true, preview_url, repo_url };
}

export async function patchLatestRequirementStatusColumns(params: {
  requirementId: string;
  siteId?: string;
  instanceId?: string;
  columns: Partial<Record<'repo_url' | 'preview_url' | 'source_code', string>>;
}): Promise<{ updated: boolean; created?: boolean; error?: string }> {
  const { requirementId, instanceId, columns } = params;
  const resolvedSiteId = await resolveSiteIdForRequirementStatus({
    requirementId,
    siteId: params.siteId,
    instanceId,
  });
  if (!resolvedSiteId) {
    const msg =
      'Cannot resolve site_id (requirements.site_id empty and instance has no site — check requirement and robot_instances).';
    console.warn('[RequirementStatusPatch]', msg, requirementId);
    return { updated: false, error: msg };
  }

  const patch: Record<string, string> = {};
  for (const key of ['repo_url', 'preview_url', 'source_code'] as const) {
    const v = columns[key];
    if (typeof v === 'string' && v.trim() !== '') {
      patch[key] = v.trim();
    }
  }
  if (Object.keys(patch).length === 0) {
    return { updated: false, error: 'No deliverable columns to write (empty patch).' };
  }
  patch.updated_at = new Date().toISOString();

  const validInstance = instanceId && UUID_RE.test(instanceId) ? instanceId : null;

  let rowId: string | null = null;
  if (validInstance) {
    const { data: scoped } = await supabaseAdmin
      .from('requirement_status')
      .select('id')
      .eq('requirement_id', requirementId)
      .eq('instance_id', validInstance)
      .order('created_at', { ascending: false })
      .limit(1);
    rowId = scoped?.[0]?.id ?? null;
  }
  if (!rowId) {
    const { data: anyRow } = await supabaseAdmin
      .from('requirement_status')
      .select('id')
      .eq('requirement_id', requirementId)
      .order('created_at', { ascending: false })
      .limit(1);
    rowId = anyRow?.[0]?.id ?? null;
  }

  if (rowId) {
    const { error: upErr } = await supabaseAdmin.from('requirement_status').update(patch).eq('id', rowId);
    if (upErr) {
      console.warn('[RequirementStatusPatch] Update failed:', upErr.message);
      return { updated: false, error: upErr.message };
    }
    console.log(
      `[RequirementStatusPatch] Updated ${rowId} (${Object.keys(patch)
        .filter((k) => k !== 'updated_at')
        .join(', ')})`,
    );
    if (columns.preview_url?.trim()) {
      await logInstancePreviewUrlRecorded({
        siteId: resolvedSiteId,
        instanceId: validInstance ?? instanceId ?? null,
        requirementId,
        previewUrl: columns.preview_url.trim(),
        context: 'requirement_status_patch',
        repoUrl: columns.repo_url ?? null,
      });
    }
    return { updated: true };
  }

  try {
    await createRequirementStatusCore({
      site_id: resolvedSiteId,
      instance_id: validInstance ?? undefined,
      requirement_id: requirementId,
      repo_url: patch.repo_url,
      preview_url: patch.preview_url,
      source_code: patch.source_code,
      status: 'in-progress',
      message: 'Deliverables recorded from sandbox checkpoint (repo, preview, source archive).',
    });
    console.log(`[RequirementStatusPatch] Inserted requirement_status for ${requirementId}`);
    if (patch.preview_url) {
      await logInstancePreviewUrlRecorded({
        siteId: resolvedSiteId,
        instanceId: validInstance ?? instanceId ?? null,
        requirementId,
        previewUrl: patch.preview_url,
        context: 'requirement_status_insert',
        repoUrl: patch.repo_url ?? null,
      });
    }
    return { updated: true, created: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[RequirementStatusPatch] Insert failed:', msg);
    return { updated: false, error: msg };
  }
}
