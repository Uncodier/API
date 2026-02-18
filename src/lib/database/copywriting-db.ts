/**
 * Database operations for copywriting (approved copy templates, etc.)
 */

import { supabaseAdmin } from './supabase-client';

export const COPY_TYPES = [
  'email',
  'sms',
  'whatsapp',
  'web_content',
  'social_media',
  'ad_copy',
  'sales_script',
  'other',
] as const;

export const COPY_STATUSES = ['draft', 'review', 'approved', 'archived'] as const;

export type CopyType = (typeof COPY_TYPES)[number];
export type CopyStatus = (typeof COPY_STATUSES)[number];

export interface DbCopywriting {
  id: string;
  site_id: string;
  copy_type: string;
  title: string;
  content: string;
  status: string;
  target_audience: string | null;
  use_case: string | null;
  notes: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
  user_id: string | null;
}

export interface CopywritingFilters {
  copywriting_id?: string;
  site_id?: string;
  user_id?: string;
  copy_type?: CopyType;
  status?: CopyStatus;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CreateCopywritingParams {
  site_id: string;
  copy_type: CopyType;
  title: string;
  content: string;
  status?: CopyStatus;
  user_id?: string;
  target_audience?: string;
  use_case?: string;
  notes?: string;
  tags?: string[];
}

export interface UpdateCopywritingParams {
  copy_type?: CopyType;
  title?: string;
  content?: string;
  status?: CopyStatus;
  target_audience?: string;
  use_case?: string;
  notes?: string;
  tags?: string[];
}

export async function getCopywritings(filters: CopywritingFilters): Promise<{
  copywritings: DbCopywriting[];
  total: number;
  hasMore: boolean;
}> {
  let query = supabaseAdmin.from('copywriting').select('*', { count: 'exact' });

  if (filters.copywriting_id) query = query.eq('id', filters.copywriting_id);
  if (filters.site_id) query = query.eq('site_id', filters.site_id);
  if (filters.user_id) query = query.eq('user_id', filters.user_id);
  if (filters.copy_type) query = query.eq('copy_type', filters.copy_type);
  if (filters.status) query = query.eq('status', filters.status);

  if (filters.search) {
    query = query.or(
      `title.ilike.%${filters.search}%,content.ilike.%${filters.search}%,target_audience.ilike.%${filters.search}%`
    );
  }

  const sortBy = filters.sort_by || 'created_at';
  const sortOrder = filters.sort_order || 'desc';
  query = query.order(sortBy, { ascending: sortOrder === 'asc' });

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Error getting copywriting: ${error.message}`);
  }

  const total = count ?? (data?.length ?? 0);
  return {
    copywritings: (data ?? []) as DbCopywriting[],
    total,
    hasMore: total > offset + (data?.length ?? 0),
  };
}

export async function getCopywritingById(id: string): Promise<DbCopywriting | null> {
  const { data, error } = await supabaseAdmin
    .from('copywriting')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Error getting copywriting: ${error.message}`);
  }
  return data as DbCopywriting | null;
}

export async function createCopywriting(params: CreateCopywritingParams): Promise<DbCopywriting> {
  const insertData: Record<string, unknown> = {
    site_id: params.site_id,
    copy_type: params.copy_type,
    title: params.title,
    content: params.content,
    status: params.status ?? 'draft',
  };

  if (params.user_id) insertData.user_id = params.user_id;
  if (params.target_audience) insertData.target_audience = params.target_audience;
  if (params.use_case) insertData.use_case = params.use_case;
  if (params.notes) insertData.notes = params.notes;
  if (params.tags) insertData.tags = params.tags;

  const { data, error } = await supabaseAdmin
    .from('copywriting')
    .insert([insertData])
    .select('*')
    .single();

  if (error) {
    throw new Error(`Error creating copywriting: ${error.message}`);
  }

  return data as DbCopywriting;
}

export async function updateCopywriting(id: string, params: UpdateCopywritingParams): Promise<DbCopywriting> {
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (params.copy_type !== undefined) updateData.copy_type = params.copy_type;
  if (params.title !== undefined) updateData.title = params.title;
  if (params.content !== undefined) updateData.content = params.content;
  if (params.status !== undefined) updateData.status = params.status;
  if (params.target_audience !== undefined) updateData.target_audience = params.target_audience;
  if (params.use_case !== undefined) updateData.use_case = params.use_case;
  if (params.notes !== undefined) updateData.notes = params.notes;
  if (params.tags !== undefined) updateData.tags = params.tags;

  const { data, error } = await supabaseAdmin
    .from('copywriting')
    .update(updateData)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Error updating copywriting: ${error.message}`);
  }

  return data as DbCopywriting;
}

export async function deleteCopywriting(id: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('copywriting')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Error deleting copywriting: ${error.message}`);
  }
}
