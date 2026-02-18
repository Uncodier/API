import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createCopywriting, COPY_TYPES, COPY_STATUSES } from '@/lib/database/copywriting-db';

const CreateCopywritingSchema = z.object({
  site_id: z.string().uuid('Valid site_id required'),
  user_id: z.string().uuid().optional(),
  title: z.string().min(1, 'Title is required'),
  copy_type: z.enum(COPY_TYPES),
  content: z.string().min(1, 'Content is required'),
  status: z.enum(COPY_STATUSES).optional().default('draft'),
  target_audience: z.string().optional(),
  use_case: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

async function resolveUserId(siteId: string, userId?: string): Promise<string | undefined> {
  if (userId) return userId;
  const { data } = await supabaseAdmin
    .from('sites')
    .select('user_id')
    .eq('id', siteId)
    .single();
  return data?.user_id;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = CreateCopywritingSchema.parse(body);
    const effectiveUserId = await resolveUserId(validated.site_id, validated.user_id);

    const copywriting = await createCopywriting({
      site_id: validated.site_id,
      user_id: effectiveUserId,
      title: validated.title,
      copy_type: validated.copy_type,
      content: validated.content,
      status: validated.status,
      target_audience: validated.target_audience,
      use_case: validated.use_case,
      notes: validated.notes,
      tags: validated.tags,
    });

    return NextResponse.json(
      {
        success: true,
        copywriting,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid input',
          details: error.errors,
        },
        { status: 400 }
      );
    }
    if (error instanceof Error) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 500 }
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
}
