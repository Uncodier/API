import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface AgentProject {
  id: string;
  name: string;
}

/** Use the current SQL license policy, not membership presence or cached access. */
export async function canAccessAgentProject(userId: string, siteId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc('site_user_has_effective_access', {
    p_site_id: siteId, p_user_id: userId,
  });
  if (error || typeof data !== 'boolean') throw new Error('Agent project authorization unavailable');
  return data;
}

export async function getAvailableAgentProjects(userId: string): Promise<AgentProject[]> {
  const [owned, memberships] = await Promise.all([
    supabaseAdmin.from('sites').select('id, name').eq('user_id', userId),
    supabaseAdmin.from('site_members').select('site_id, sites:site_id(id, name)').eq('user_id', userId),
  ]);
  if (owned.error || memberships.error) throw new Error('Agent projects unavailable');
  const candidates = new Map<string, AgentProject>();
  for (const site of owned.data ?? []) candidates.set(site.id, site);
  for (const member of memberships.data ?? []) {
    const site = member.sites as unknown as AgentProject | null;
    if (site?.id) candidates.set(site.id, { id: site.id, name: site.name });
  }
  const checked = await Promise.all(Array.from(candidates.values()).map(async project => ({
    project, allowed: await canAccessAgentProject(userId, project.id),
  })));
  return checked.filter(result => result.allowed).map(result => result.project);
}

/** Never reuse an instance from another actor or an unavailable project. */
export function resolveAgentProjectSession(
  userId: string,
  projects: AgentProject[],
  session: { user_id?: string; site_id?: string; instance_id?: string | null } | null,
) {
  const valid = session?.user_id === userId && projects.some(project => project.id === session.site_id);
  return {
    siteId: valid ? session!.site_id! : null,
    instanceId: valid ? session!.instance_id ?? null : null,
    unavailableSession: Boolean(session?.site_id && !valid),
  };
}

export const AGENT_PROJECT_SELECTION_PROMPT = "You are Makinari's Gear Assistant. The previous project may no longer be available because access or its license changed. Use instance_project with action='list' to show only currently accessible projects and ask which one the user wants to manage. If they choose one, use action='set' with its site_id. Do not perform any other changes or reuse the previous project's data until they select a project.";
export const AGENT_NO_PROJECTS_PROMPT = "You are Makinari's Gear Assistant. The user is registered but has no currently accessible projects. Explain that their previous project's access or license may be unavailable. Ask them to log in to the web app to review access and licenses or create a project. Do not access unavailable project data or create a project from here.";