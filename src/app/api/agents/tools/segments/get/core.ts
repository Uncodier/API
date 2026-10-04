import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const GetSegmentsSchema = z.object({
  segment_id: z.string().uuid().optional(),
  site_id: z.string().uuid('Site ID is required'),
  user_id: z.string().uuid().optional(),
  name: z.string().optional(), // search by name
  is_active: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export async function getSegmentCore(filters: Record<string, unknown>) {
  const validated = GetSegmentsSchema.parse(filters);

  if (validated.segment_id) {
    const { data: segment, error } = await supabaseAdmin
      .from('segments')
      .select('*')
      .eq('id', validated.segment_id)
      .single();

    if (error) {
      // If not found return null
      if (error.code === 'PGRST116') return { success: true, data: { segment: null } };
      throw new Error(error.message);
    }

    if (segment.site_id !== validated.site_id) {
      throw new Error('No tienes permiso para ver este segmento');
    }

    return {
      success: true,
      data: {
        segment,
      },
    };
  }

  let query = supabaseAdmin
    .from('segments')
    .select('*', { count: 'exact' });

  if (validated.site_id) query = query.eq('site_id', validated.site_id);
  if (validated.user_id) query = query.eq('user_id', validated.user_id);
  if (validated.is_active !== undefined) query = query.eq('is_active', validated.is_active);
  if (validated.name) query = query.ilike('name', `%${validated.name}%`);

  const { data: segments, error, count } = await query
    .range(validated.offset, validated.offset + validated.limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return {
    success: true,
    data: {
      segments,
      pagination: {
        total: count,
        count: segments.length,
        offset: validated.offset,
        limit: validated.limit,
        has_more: (count || 0) > validated.offset + segments.length,
      },
    },
  };
}

