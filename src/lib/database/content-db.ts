/**
 * Database operations for content (blog posts, videos, etc.)
 */

import { supabaseAdmin } from './supabase-client';

export const CONTENT_TYPES = [
  'blog_post',
  'video',
  'podcast',
  'social_post',
  'newsletter',
  'case_study',
  'whitepaper',
  'infographic',
  'webinar',
  'ebook',
  'ad',
  'landing_page',
] as const;

export const CONTENT_STATUSES = ['draft', 'review', 'approved', 'published', 'archived'] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export interface DbContent {
  id: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  segment_id: string | null;
  site_id: string;
  author_id: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  tags: string[] | null;
  estimated_reading_time: number | null;
  word_count: number | null;
  seo_score: number | null;
  user_id: string | null;
  text: string | null;
  campaign_id: string | null;
  performance_rating: number | null;
  metadata: Record<string, unknown> | null;
  command_id: string | null;
  instructions: string | null;
}

export interface ContentFilters {
  content_id?: string;
  site_id?: string;
  user_id?: string;
  type?: ContentType;
  status?: ContentStatus;
  campaign_id?: string;
  segment_id?: string;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CreateContentParams {
  title: string;
  description?: string;
  type: ContentType;
  site_id: string;
  user_id?: string;
  status?: ContentStatus;
  segment_id?: string;
  text?: string;
  tags?: string[];
  instructions?: string;
  campaign_id?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateContentParams {
  title?: string;
  description?: string;
  type?: ContentType;
  status?: ContentStatus;
  segment_id?: string;
  text?: string;
  tags?: string[];
  instructions?: string;
  campaign_id?: string;
  metadata?: Record<string, unknown>;
  published_at?: string | null;
}

export async function getContents(filters: ContentFilters): Promise<{
  contents: DbContent[];
  total: number;
  hasMore: boolean;
}> {
  let query = supabaseAdmin.from('content').select('*', { count: 'exact' });

  if (filters.site_id) query = query.eq('site_id', filters.site_id);
  if (filters.user_id) query = query.eq('user_id', filters.user_id);
  if (filters.type) query = query.eq('type', filters.type);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.campaign_id) query = query.eq('campaign_id', filters.campaign_id);
  if (filters.segment_id) query = query.eq('segment_id', filters.segment_id);

  if (filters.search) {
    query = query.or(
      `title.ilike.%${filters.search}%,description.ilike.%${filters.search}%,text.ilike.%${filters.search}%`
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
    throw new Error(`Error getting content: ${error.message}`);
  }

  const total = count ?? (data?.length ?? 0);
  return {
    contents: (data ?? []) as DbContent[],
    total,
    hasMore: total > offset + (data?.length ?? 0),
  };
}

export async function getContentById(id: string): Promise<DbContent | null> {
  const { data, error } = await supabaseAdmin
    .from('content')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Error getting content: ${error.message}`);
  }
  return data as DbContent | null;
}

export async function createContent(params: CreateContentParams): Promise<DbContent> {
  const insertData: Record<string, unknown> = {
    title: params.title,
    type: params.type,
    site_id: params.site_id,
    status: params.status ?? 'draft',
  };

  if (params.description) insertData.description = params.description;
  if (params.user_id) insertData.user_id = params.user_id;
  if (params.segment_id) insertData.segment_id = params.segment_id;
  if (params.text) insertData.text = params.text;
  if (params.tags) insertData.tags = params.tags;
  if (params.instructions) insertData.instructions = params.instructions;
  if (params.campaign_id) insertData.campaign_id = params.campaign_id;
  if (params.metadata) insertData.metadata = params.metadata;

  const { data, error } = await supabaseAdmin
    .from('content')
    .insert([insertData])
    .select('*')
    .single();

  if (error) {
    throw new Error(`Error creating content: ${error.message}`);
  }

  return data as DbContent;
}

export async function updateContent(id: string, params: UpdateContentParams): Promise<DbContent> {
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (params.title !== undefined) updateData.title = params.title;
  if (params.description !== undefined) updateData.description = params.description;
  if (params.type !== undefined) updateData.type = params.type;
  if (params.status !== undefined) updateData.status = params.status;
  if (params.segment_id !== undefined) updateData.segment_id = params.segment_id;
  if (params.text !== undefined) updateData.text = params.text;
  if (params.tags !== undefined) updateData.tags = params.tags;
  if (params.instructions !== undefined) updateData.instructions = params.instructions;
  if (params.campaign_id !== undefined) updateData.campaign_id = params.campaign_id;
  if (params.metadata !== undefined) updateData.metadata = params.metadata;
  if (params.published_at !== undefined) updateData.published_at = params.published_at;

  const { data, error } = await supabaseAdmin
    .from('content')
    .update(updateData)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Error updating content: ${error.message}`);
  }

  return data as DbContent;
}
