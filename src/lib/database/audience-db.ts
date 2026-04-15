/**
 * Database operations for audiences (stored lead lists)
 */

import { supabaseAdmin } from './supabase-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DbAudience {
  id: string;
  name: string;
  description: string | null;
  site_id: string;
  user_id: string;
  instance_id: string | null;
  filters: Record<string, unknown>;
  total_count: number;
  page_size: number;
  status: 'building' | 'ready' | 'error';
  created_at: string;
  updated_at: string;
}

export interface DbAudienceLead {
  id: string;
  audience_id: string;
  lead_id: string;
  page_number: number;
  send_status: 'pending' | 'sent' | 'failed' | 'skipped';
  sent_at: string | null;
  error: string | null;
  created_at: string;
}

export interface CreateAudienceParams {
  name: string;
  description?: string;
  site_id: string;
  user_id: string;
  instance_id?: string;
  filters: Record<string, unknown>;
  total_count?: number;
  page_size?: number;
  status?: DbAudience['status'];
}

// ---------------------------------------------------------------------------
// Audience CRUD
// ---------------------------------------------------------------------------

export async function createAudience(params: CreateAudienceParams): Promise<DbAudience> {
  const { data, error } = await supabaseAdmin
    .from('audiences')
    .insert([{
      name: params.name,
      description: params.description ?? null,
      site_id: params.site_id,
      user_id: params.user_id,
      instance_id: params.instance_id ?? null,
      filters: params.filters,
      total_count: params.total_count ?? 0,
      page_size: params.page_size ?? 50,
      status: params.status ?? 'building',
    }])
    .select('*')
    .single();

  if (error) throw new Error(`Error creating audience: ${error.message}`);
  return data as DbAudience;
}

export async function getAudienceById(id: string): Promise<DbAudience | null> {
  const { data, error } = await supabaseAdmin
    .from('audiences')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Error getting audience: ${error.message}`);
  }
  return (data as DbAudience) ?? null;
}

export async function getAudiencesBySite(siteId: string): Promise<DbAudience[]> {
  const { data, error } = await supabaseAdmin
    .from('audiences')
    .select('*')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error listing audiences: ${error.message}`);
  return (data ?? []) as DbAudience[];
}

export async function updateAudience(
  id: string,
  updates: Partial<Pick<DbAudience, 'name' | 'description' | 'total_count' | 'status'>>,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('audiences')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`Error updating audience: ${error.message}`);
}

export async function deleteAudience(id: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('audiences')
    .delete()
    .eq('id', id);

  if (error) throw new Error(`Error deleting audience: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Audience Leads
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

/**
 * Bulk-insert lead references into audience_leads with pre-computed page numbers.
 * Inserts in batches to avoid payload limits.
 */
export async function insertAudienceLeads(
  audienceId: string,
  leadIds: string[],
  pageSize: number,
): Promise<void> {
  const rows = leadIds.map((leadId, idx) => ({
    audience_id: audienceId,
    lead_id: leadId,
    page_number: Math.floor(idx / pageSize) + 1,
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabaseAdmin.from('audience_leads').insert(batch);
    if (error) throw new Error(`Error inserting audience leads batch: ${error.message}`);
  }
}

/**
 * Fetch a page of audience leads joined with full lead data.
 */
export async function getAudiencePage(
  audienceId: string,
  page: number,
): Promise<{ leads: Record<string, unknown>[]; total_in_page: number }> {
  const { data, error } = await supabaseAdmin
    .from('audience_leads')
    .select('lead_id, page_number, send_status, leads(*)')
    .eq('audience_id', audienceId)
    .eq('page_number', page)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Error getting audience page: ${error.message}`);

  const leads = (data ?? []).map((row: any) => ({
    ...row.leads,
    send_status: row.send_status,
  }));

  return { leads, total_in_page: leads.length };
}

/**
 * Same as getAudiencePage but only returns leads still pending send.
 */
export async function getAudiencePageForSending(
  audienceId: string,
  page: number,
): Promise<{ leads: Record<string, unknown>[]; total_in_page: number }> {
  const { data, error } = await supabaseAdmin
    .from('audience_leads')
    .select('lead_id, page_number, send_status, leads(*)')
    .eq('audience_id', audienceId)
    .eq('page_number', page)
    .eq('send_status', 'pending')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Error getting audience page for sending: ${error.message}`);

  const leads = (data ?? []).map((row: any) => ({
    ...row.leads,
    send_status: row.send_status,
  }));

  return { leads, total_in_page: leads.length };
}

/**
 * Update the send status for a single audience lead.
 */
export async function updateAudienceLeadStatus(
  audienceId: string,
  leadId: string,
  status: DbAudienceLead['send_status'],
  errorMsg?: string,
): Promise<void> {
  const updates: Record<string, unknown> = { send_status: status };
  if (status === 'sent') updates.sent_at = new Date().toISOString();
  if (errorMsg) updates.error = errorMsg;

  const { error } = await supabaseAdmin
    .from('audience_leads')
    .update(updates)
    .eq('audience_id', audienceId)
    .eq('lead_id', leadId);

  if (error) throw new Error(`Error updating audience lead status: ${error.message}`);
}
