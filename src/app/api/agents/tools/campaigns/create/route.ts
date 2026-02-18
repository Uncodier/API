import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const CreateCampaignSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  site_id: z.string().uuid('Valid site_id required'),
  user_id: z.string().uuid('Valid user_id required').optional(),
  status: z.string().optional().default('pending'),
  type: z.string().optional().default('general'),
  priority: z.string().optional().default('medium'),
  budget: z.any().optional(), // Can be object or string, better to type as any here and sanitize if needed
  revenue: z.any().optional(),
  due_date: z.string().optional(),
  command_id: z.string().uuid().optional(),
});

async function resolveUserId(siteId: string, userId?: string): Promise<string> {
  if (userId) return userId;
  const { data } = await supabaseAdmin
    .from('sites')
    .select('user_id')
    .eq('id', siteId)
    .single();
  if (!data?.user_id) {
    throw new Error('user_id required: provide it or ensure site has user_id');
  }
  return data.user_id;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = CreateCampaignSchema.parse(body);
    const effectiveUserId = await resolveUserId(validated.site_id, validated.user_id);

    const campaignData = {
      title: validated.title,
      description: validated.description,
      status: validated.status,
      type: validated.type,
      priority: validated.priority,
      budget: validated.budget,
      revenue: validated.revenue,
      due_date: validated.due_date,
      site_id: validated.site_id,
      user_id: effectiveUserId,
      command_id: validated.command_id,
    };

    const { data: campaign, error } = await supabaseAdmin
      .from('campaigns')
      .insert(campaignData)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      success: true,
      campaign,
    }, { status: 201 });
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
