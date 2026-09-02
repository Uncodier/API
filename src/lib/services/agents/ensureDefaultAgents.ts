import { supabaseAdmin } from '@/lib/database/supabase-client';
import { buildActivitiesConfig, DEFAULT_AGENT_TEMPLATES } from './default-agent-templates';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EnsureDefaultAgentsResult = {
  created: string[];
  reactivated: string[];
  existing: string[];
};

export type ActiveAgentRef = {
  agentId: string;
  userId: string;
  role: string;
};

type AgentRow = {
  id: string;
  role: string | null;
  status: string | null;
  user_id: string | null;
};

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function findActiveAgentForRole(
  siteId: string,
  role: string
): Promise<ActiveAgentRef | null> {
  if (!siteId || !isValidUuid(siteId) || !role) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('id, user_id, role, status')
    .eq('site_id', siteId)
    .eq('role', role)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error(`[ensureDefaultAgents] Error looking up role "${role}" for site ${siteId}:`, error);
    return null;
  }

  const row = data?.[0];
  if (!row?.id || !row.user_id) {
    return null;
  }

  return {
    agentId: row.id,
    userId: row.user_id,
    role: row.role || role,
  };
}

export async function ensureDefaultAgents(
  siteId: string,
  userId: string
): Promise<EnsureDefaultAgentsResult> {
  const result: EnsureDefaultAgentsResult = {
    created: [],
    reactivated: [],
    existing: [],
  };

  if (!siteId || !isValidUuid(siteId) || !userId || !isValidUuid(userId)) {
    console.error('[ensureDefaultAgents] Invalid siteId or userId', { siteId, userId });
    return result;
  }

  const { data: existingAgents, error } = await supabaseAdmin
    .from('agents')
    .select('id, role, status, user_id')
    .eq('site_id', siteId);

  if (error) {
    console.error(`[ensureDefaultAgents] Failed to load agents for site ${siteId}:`, error);
    throw error;
  }

  const byRole = new Map<string, AgentRow>();
  for (const row of existingAgents || []) {
    if (row?.role && !byRole.has(row.role)) {
      byRole.set(row.role, row);
    }
  }

  const now = new Date().toISOString();

  for (const template of DEFAULT_AGENT_TEMPLATES) {
    const current = byRole.get(template.role);

    if (current?.status === 'active') {
      result.existing.push(template.role);
      continue;
    }

    if (current && current.status !== 'active') {
      const { error: reactivateError } = await supabaseAdmin
        .from('agents')
        .update({ status: 'active', updated_at: now })
        .eq('id', current.id);

      if (reactivateError) {
        console.error(`[ensureDefaultAgents] Failed to reactivate ${template.role}:`, reactivateError);
        continue;
      }

      result.reactivated.push(template.role);
      continue;
    }

    const { error: insertError } = await supabaseAdmin.from('agents').insert({
      name: template.name,
      description: template.description,
      type: template.type,
      status: 'active',
      prompt: template.prompt,
      backstory: template.backstory,
      role: template.role,
      tools: {},
      activities: buildActivitiesConfig(template.activities),
      integrations: {},
      configuration: {},
      site_id: siteId,
      user_id: userId,
      created_at: now,
      updated_at: now,
    });

    if (insertError) {
      console.error(`[ensureDefaultAgents] Failed to create ${template.role}:`, insertError);
      continue;
    }

    result.created.push(template.role);
  }

  console.log(`[ensureDefaultAgents] Site ${siteId}:`, result);
  return result;
}
