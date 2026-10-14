import { supabaseAdmin } from '@/lib/database/supabase-client';
import { decryptToken } from '@/lib/utils/token-decryption';
import { parseGitBindingFromMetadata, resolveDefaultGitBinding } from '@/lib/services/requirement-git-binding';
import { branchBelongsToRequirement, buildRequirementBranchName } from '@/lib/services/requirement-branch';
import type { HostProfile } from './profile';
import type { RequirementContext, RequirementRun } from './requirement-types';
import { CAPABILITY_MANIFEST } from './capabilities';

/** Repository/runtime configuration comes from existing product records, not a manual V2 profile. */
export async function buildRequirementProfile(run: RequirementRun, context: RequirementContext): Promise<{
  profile: HostProfile; repository: { url: string; ref?: string }; branch: string;
}> {
  const req = context.requirement;
  const binding = parseGitBindingFromMetadata(req.metadata) || resolveDefaultGitBinding(req.type);
  const explicitUrl = req.metadata?.git?.url;
  const url = typeof explicitUrl === 'string' ? explicitUrl : `https://github.com/${binding.org}/${binding.repo}.git`;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid requirement repository binding');
  let branch = buildRequirementBranchName(req.id, req.title);
  const { data: previousStatuses, error: historyError } = await supabaseAdmin.from('requirement_status').select('repo_url')
    .eq('requirement_id', run.requirementId).eq('site_id', run.siteId).eq('instance_id', run.instanceId)
    .not('repo_url', 'is', null).order('created_at', { ascending: false }).limit(10);
  if (historyError) throw new Error('Requirement branch history unavailable');
  const prior = (previousStatuses || []).find(row => typeof row.repo_url === 'string' && row.repo_url.includes('/tree/'));
  if (prior) {
    const previous = new URL(prior.repo_url);
    const previousBranch = previous.pathname.split('/tree/')[1];
    const repoPath = parsed.pathname.replace(/\.git$/, '');
    if (previous.origin === parsed.origin && previous.pathname.split('/tree/')[0] === repoPath && branchBelongsToRequirement(previousBranch, req.id)) branch = previousBranch;
  }
  const environment: Record<string, string> = {};
  const { data: secrets, error } = await supabaseAdmin.from('site_secrets').select('name,encrypted_value')
    .eq('site_id', run.siteId).or(`instance_id.is.null,instance_id.eq.${run.instanceId}`);
  if (error) throw new Error('Requirement runtime configuration unavailable');
  for (const secret of secrets || []) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(secret.name) || /^(?:APPS_|SUPABASE_|NEXT_PUBLIC_APPS_|NEXT_PUBLIC_SUPABASE_|API_KEY$|PATH$|HOME$|NODE_OPTIONS$|GIT_|GITHUB_|VERCEL_|AWS_|OPENROUTER_)/.test(secret.name) ||
      /SERVICE_ROLE|ENCRYPTION_KEY|CRON_SECRET|SERVICE_API_KEY|OPENROUTER_API_KEY/.test(secret.name)) continue;
    const value = secret.encrypted_value ? decryptToken(secret.encrypted_value) : null;
    if (value) environment[secret.name] = value;
  }
  const profile: HostProfile = {
    siteId: run.siteId, userId: run.userId, repositoryUrl: url, requirementId: req.id,
    // All existing safe capabilities are tools. No capability is run automatically.
    allowed: [...CAPABILITY_MANIFEST.implemented.map(entry => entry.name), 'tracking_install', 'source_archive', 'deployment_status'],
    environment,
  };
  if (parsed.hostname === 'github.com' && process.env.GITHUB_TOKEN?.trim()) {
    profile.git = { username: 'x-access-token', password: process.env.GITHUB_TOKEN.trim(), allowPush: true };
  }
  const projectId = binding.kind === 'automation' ? process.env.VERCEL_PROJECT_ID_AUTOMATION : process.env.APPS_VERCEL_PROJECT_ID;
  const token = process.env.VERCEL_TOKEN || process.env.VERCEL_ACCESS_TOKEN;
  if (projectId && token) profile.deployment = { projectId, token, teamId: process.env.VERCEL_TEAM_ID };
  return { profile, repository: { url, ref: binding.default_branch }, branch };
}