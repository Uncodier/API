/**
 * Database operations for leads (CRM leads)
 */

import { supabaseAdmin } from './supabase-server';

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'] as const;

export interface DbLead {
  id: string;
  name: string;
  email: string;
  personal_email: string | null;
  position: string | null;
  segment_id: string | null;
  status: string;
  notes: string | null;
  last_contact: string | null;
  site_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  phone: string | null;
  origin: string | null;
  social_networks: Record<string, unknown> | null;
  address: Record<string, unknown> | null;
  company: Record<string, unknown> | null;
  subscription: Record<string, unknown> | null;
  birthday: string | null;
  campaign_id: string | null;
  command_id: string | null;
  language: string | null;
  company_id: string | null;
  attribution: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  assignee_id: string | null;
  referral_lead_id: string | null;
}

export interface LeadFilters {
  site_id?: string;
  user_id?: string;
  status?: string;
  segment_id?: string;
  campaign_id?: string;
  assignee_id?: string;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CreateLeadParams {
  name: string;
  email: string;
  site_id: string;
  user_id: string;
  phone?: string;
  position?: string;
  company?: Record<string, unknown> | string;
  notes?: string;
  status?: string;
  origin?: string;
  segment_id?: string;
  campaign_id?: string;
  assignee_id?: string;
}

export interface UpdateLeadParams {
  name?: string;
  email?: string;
  phone?: string;
  position?: string;
  company?: Record<string, unknown> | string;
  notes?: string;
  status?: string;
  origin?: string;
  segment_id?: string;
  campaign_id?: string;
  assignee_id?: string;
}

export async function getLeads(filters: LeadFilters): Promise<{
  leads: DbLead[];
  total: number;
  hasMore: boolean;
}> {
  let query = supabaseAdmin
    .from('leads')
    .select('*', { count: 'exact' });

  if (filters.site_id) query = query.eq('site_id', filters.site_id);
  if (filters.user_id) query = query.eq('user_id', filters.user_id);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.segment_id) query = query.eq('segment_id', filters.segment_id);
  if (filters.campaign_id) query = query.eq('campaign_id', filters.campaign_id);
  if (filters.assignee_id) query = query.eq('assignee_id', filters.assignee_id);

  if (filters.search) {
    query = query.or(`name.ilike.%${filters.search}%,email.ilike.%${filters.search}%,notes.ilike.%${filters.search}%`);
  }

  const sortBy = filters.sort_by || 'created_at';
  const sortOrder = filters.sort_order || 'desc';
  query = query.order(sortBy, { ascending: sortOrder === 'asc' });

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Error getting leads: ${error.message}`);
  }

  const total = count ?? (data?.length ?? 0);
  return {
    leads: (data ?? []) as DbLead[],
    total,
    hasMore: total > offset + (data?.length ?? 0),
  };
}

export async function getLeadById(id: string): Promise<DbLead | null> {
  const { data, error } = await supabaseAdmin
    .from('leads')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Error getting lead: ${error.message}`);
  }
  return data as DbLead | null;
}

function normalizeCompany(company: Record<string, unknown> | string | undefined): Record<string, unknown> | null {
  if (!company) return null;
  if (typeof company === 'string') return { name: company };
  return company as Record<string, unknown>;
}

export async function createLead(params: CreateLeadParams): Promise<DbLead> {
  const insertData: Record<string, unknown> = {
    name: params.name,
    email: params.email,
    site_id: params.site_id,
    user_id: params.user_id,
    status: params.status ?? 'new',
  };

  if (params.phone) insertData.phone = params.phone;
  if (params.position) insertData.position = params.position;
  if (params.notes) insertData.notes = params.notes;
  if (params.origin) insertData.origin = params.origin;
  if (params.segment_id) insertData.segment_id = params.segment_id;
  if (params.campaign_id) insertData.campaign_id = params.campaign_id;
  if (params.assignee_id) insertData.assignee_id = params.assignee_id;
  const company = normalizeCompany(params.company);
  if (company) insertData.company = company;

  const { data, error } = await supabaseAdmin
    .from('leads')
    .insert([insertData])
    .select('*')
    .single();

  if (error) {
    throw new Error(`Error creating lead: ${error.message}`);
  }

  return data as DbLead;
}

export async function updateLead(id: string, params: UpdateLeadParams): Promise<DbLead> {
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.name !== undefined) updateData.name = params.name;
  if (params.email !== undefined) updateData.email = params.email;
  if (params.phone !== undefined) updateData.phone = params.phone;
  if (params.position !== undefined) updateData.position = params.position;
  if (params.notes !== undefined) updateData.notes = params.notes;
  if (params.status !== undefined) updateData.status = params.status;
  if (params.origin !== undefined) updateData.origin = params.origin;
  if (params.segment_id !== undefined) updateData.segment_id = params.segment_id;
  if (params.campaign_id !== undefined) updateData.campaign_id = params.campaign_id;
  if (params.assignee_id !== undefined) updateData.assignee_id = params.assignee_id;
  if (params.company !== undefined) {
    updateData.company = normalizeCompany(params.company);
  }

  const { data, error } = await supabaseAdmin
    .from('leads')
    .update(updateData)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Error updating lead: ${error.message}`);
  }

  return data as DbLead;
}
