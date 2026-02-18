import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const GetCampaignsSchema = z.object({
  campaign_id: z.string().uuid().optional(),
  site_id: z.string().uuid('Site ID is required'),
  user_id: z.string().uuid().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  priority: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export async function getCampaignCore(filters: Record<string, unknown>) {
  const validated = GetCampaignsSchema.parse(filters);

  if (validated.campaign_id) {
    const { data: campaign, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', validated.campaign_id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return { success: true, data: { campaign: null } };
      throw new Error(error.message);
    }

    if (campaign.site_id !== validated.site_id) {
      throw new Error('No tienes permiso para ver esta campaña');
    }

    return {
      success: true,
      data: {
        campaign,
      },
    };
  }

  let query = supabaseAdmin
    .from('campaigns')
    .select('*', { count: 'exact' });

  if (validated.site_id) query = query.eq('site_id', validated.site_id);
  if (validated.user_id) query = query.eq('user_id', validated.user_id);
  if (validated.status) query = query.eq('status', validated.status);
  if (validated.type) query = query.eq('type', validated.type);
  if (validated.priority) query = query.eq('priority', validated.priority);
  if (validated.title) query = query.ilike('title', `%${validated.title}%`);

  const { data: campaigns, error, count } = await query
    .range(validated.offset, validated.offset + validated.limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return {
    success: true,
    data: {
      campaigns,
      pagination: {
        total: count,
        count: campaigns.length,
        offset: validated.offset,
        limit: validated.limit,
        has_more: (count || 0) > validated.offset + campaigns.length,
      },
    },
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getCampaignCore(body);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid input',
        details: error.errors,
      }, { status: 400 });
    }
    if (error instanceof Error) {
      return NextResponse.json({
        success: false,
        error: error.message,
      }, { status: 500 });
    }
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
    }, { status: 500 });
  }
}
