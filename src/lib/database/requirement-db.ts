/**
 * Database operations for requirements (campaign/site requirements)
 */

import { supabaseAdmin } from './supabase-server';

export const REQUIREMENT_PRIORITIES = ['high', 'medium', 'low'] as const;
export const REQUIREMENT_STATUSES = ['validated', 'in-progress', 'on-review', 'done', 'backlog', 'canceled'] as const;
export const REQUIREMENT_COMPLETION_STATUSES = ['pending', 'completed', 'rejected'] as const;
export const REQUIREMENT_TYPES = [
  'task', 'content', 'design', 'research', 'follow_up', 'develop', 'analytics', 'testing',
  'approval', 'coordination', 'strategy', 'optimization', 'automation', 'integration',
  'planning', 'payment', 'marketing_campaign', 'sales_demo', 'lead_qualification'
] as const;

export interface DbRequirement {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  completion_status: string;
  source: string | null;
  site_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  budget: number | null;
  instructions: string | null;
  command_id: string | null;
  type: string;
}

export interface RequirementFilters {
  site_id?: string;
  user_id?: string;
  campaign_id?: string;
  type?: string;
  status?: string;
  completion_status?: string;
  priority?: string;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CreateRequirementParams {
  title: string;
  description?: string;
  instructions?: string;
  priority?: string;
  status?: string;
  type?: string;
  budget?: number;
  site_id: string;
  user_id: string;
  campaign_id?: string;
  command_id?: string;
}

export interface UpdateRequirementParams {
  title?: string;
  description?: string;
  instructions?: string;
  priority?: string;
  status?: string;
  completion_status?: string;
  type?: string;
  budget?: number;
}

export async function getRequirements(filters: RequirementFilters): Promise<{
  requirements: DbRequirement[];
  total: number;
  hasMore: boolean;
}> {
  let query = supabaseAdmin
    .from('requirements')
    .select('*', { count: 'exact' });

  if (filters.site_id) query = query.eq('site_id', filters.site_id);
  if (filters.user_id) query = query.eq('user_id', filters.user_id);
  if (filters.type) query = query.eq('type', filters.type);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.completion_status) query = query.eq('completion_status', filters.completion_status);
  if (filters.priority) query = query.eq('priority', filters.priority);

  if (filters.campaign_id) {
    const { data: campaignReqs } = await supabaseAdmin
      .from('campaign_requirements')
      .select('requirement_id')
      .eq('campaign_id', filters.campaign_id);
    const reqIds = (campaignReqs ?? []).map(cr => cr.requirement_id);
    if (reqIds.length === 0) {
      return { requirements: [], total: 0, hasMore: false };
    }
    query = query.in('id', reqIds);
  }

  if (filters.search) {
    query = query.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
  }

  const sortBy = filters.sort_by || 'created_at';
  const sortOrder = filters.sort_order || 'desc';
  query = query.order(sortBy, { ascending: sortOrder === 'asc' });

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Error getting requirements: ${error.message}`);
  }

  const total = count ?? (data?.length ?? 0);
  return {
    requirements: (data ?? []) as DbRequirement[],
    total,
    hasMore: total > offset + (data?.length ?? 0),
  };
}

export async function getRequirementById(id: string): Promise<DbRequirement | null> {
  const { data, error } = await supabaseAdmin
    .from('requirements')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Error getting requirement: ${error.message}`);
  }
  return data as DbRequirement | null;
}

export async function createRequirement(params: CreateRequirementParams): Promise<DbRequirement> {
  const insertData = {
    title: params.title,
    description: params.description ?? null,
    instructions: params.instructions ?? null,
    priority: params.priority ?? 'medium',
    status: params.status ?? 'backlog',
    completion_status: 'pending',
    type: params.type ?? 'task',
    budget: params.budget ?? null,
    site_id: params.site_id,
    user_id: params.user_id,
    command_id: params.command_id ?? null,
  };

  const { data, error } = await supabaseAdmin
    .from('requirements')
    .insert([insertData])
    .select('*')
    .single();

  if (error) {
    throw new Error(`Error creating requirement: ${error.message}`);
  }

  const requirement = data as DbRequirement;

  if (params.campaign_id) {
    await supabaseAdmin
      .from('campaign_requirements')
      .insert({ campaign_id: params.campaign_id, requirement_id: requirement.id });
  }

  return requirement;
}

export async function updateRequirement(
  id: string,
  params: UpdateRequirementParams
): Promise<DbRequirement> {
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.title !== undefined) updateData.title = params.title;
  if (params.description !== undefined) updateData.description = params.description;
  if (params.instructions !== undefined) updateData.instructions = params.instructions;
  if (params.priority !== undefined) updateData.priority = params.priority;
  if (params.status !== undefined) updateData.status = params.status;
  if (params.completion_status !== undefined) updateData.completion_status = params.completion_status;
  if (params.type !== undefined) updateData.type = params.type;
  if (params.budget !== undefined) updateData.budget = params.budget;

  const { data, error } = await supabaseAdmin
    .from('requirements')
    .update(updateData)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Error updating requirement: ${error.message}`);
  }

  return data as DbRequirement;
}
