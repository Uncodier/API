import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const CreateSegmentSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  site_id: z.string().uuid('Valid site_id required'),
  user_id: z.string().uuid('Valid user_id required').optional(),
  audience: z.string().optional().default('professional'),
  size: z.number().optional().default(0),
  estimated_value: z.number().optional().default(0),
  language: z.string().optional().default('en'),
  is_active: z.boolean().optional().default(true),
  attributes: z.record(z.any()).optional(),
  analysis: z.array(z.any()).optional(),
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
    const validated = CreateSegmentSchema.parse(body);
    const effectiveUserId = await resolveUserId(validated.site_id, validated.user_id);

    const segmentData = {
      name: validated.name,
      description: validated.description,
      site_id: validated.site_id,
      user_id: effectiveUserId,
      audience: validated.audience,
      size: validated.size,
      estimated_value: validated.estimated_value,
      language: validated.language,
      is_active: validated.is_active,
      analysis: validated.analysis || (validated.attributes ? [{ type: 'attributes', data: validated.attributes }] : []),
    };

    const { data: segment, error } = await supabaseAdmin
      .from('segments')
      .insert(segmentData)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      success: true,
      segment,
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
