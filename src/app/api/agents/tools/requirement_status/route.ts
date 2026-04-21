import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { parseGithubTreeUrl, branchBelongsToRequirement } from '@/lib/services/requirement-branch';
import { getRequirementGitBinding } from '@/lib/services/requirement-git-binding';

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
  status?: string;
  message?: string;
  cycle?: string;
  endpoint_url?: string;
}) {
  const { site_id, instance_id, asset_id, requirement_id, repo_url, preview_url, source_code, status, message, cycle, endpoint_url } = params;

  if (!site_id || !requirement_id || !status) {
    throw new Error('site_id, requirement_id, and status are required');
  }

  // Deliverable gate: done only with repo_url, preview or endpoint, and source archive URL.
  const hasRepo = !!repo_url;
  const hasEndpoint = !!(preview_url || endpoint_url);
  const hasSourceArchive = !!(source_code?.trim());
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

  const isUuid = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  const validAssetId = asset_id && isUuid(asset_id) ? asset_id : null;
  const validInstanceId = instance_id && isUuid(instance_id) ? instance_id : null;

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
        status: effectiveStatus,
        message: message || null,
        cycle: cycle || null,
        endpoint_url: endpoint_url || null,
        created_at: new Date().toISOString(),
      }
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
  const isUuid = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  const validInstanceId = instance_id && isUuid(instance_id) ? instance_id : null;

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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createRequirementStatusCore(body);
    return NextResponse.json(result, { status: 201 });
  } catch (error: any) {
    console.error('Error in requirement_status tool:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: error.message.includes('are required') ? 400 : 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const requirement_id = url.searchParams.get('requirement_id');
    const instance_id = url.searchParams.get('instance_id');
    
    if (!requirement_id) {
      return NextResponse.json({ success: false, error: 'requirement_id is required' }, { status: 400 });
    }

    const result = await listRequirementStatusCore({ requirement_id, instance_id: instance_id || undefined });
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error getting requirement_status:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
