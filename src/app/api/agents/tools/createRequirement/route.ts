import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createRequirement } from '@/lib/database/requirement-db';

const CreateRequirementSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  instructions: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional().default('medium'),
  status: z.enum(['backlog', 'validated', 'in-progress', 'on-review', 'done', 'canceled']).optional().default('backlog'),
  type: z.string().optional().default('task'),
  budget: z.number().optional(),
  site_id: z.string().uuid('Valid site_id required'),
  user_id: z.string().uuid('Valid user_id required').optional(),
  campaign_id: z.string().uuid().optional(),
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
    const validated = CreateRequirementSchema.parse(body);
    const effectiveUserId = await resolveUserId(validated.site_id, validated.user_id);

    const requirement = await createRequirement({
      title: validated.title,
      description: validated.description,
      instructions: validated.instructions,
      priority: validated.priority,
      status: validated.status,
      type: validated.type,
      budget: validated.budget,
      site_id: validated.site_id,
      user_id: effectiveUserId,
      campaign_id: validated.campaign_id,
    });

    return NextResponse.json({
      success: true,
      requirement,
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
