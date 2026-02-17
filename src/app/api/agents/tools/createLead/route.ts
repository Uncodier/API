import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createLead } from '@/lib/database/lead-db';

const CreateLeadSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Valid email required'),
  site_id: z.string().uuid('Valid site_id required'),
  user_id: z.string().uuid('Valid user_id required').optional(),
  phone: z.string().optional(),
  position: z.string().optional(),
  company: z.union([z.record(z.any()), z.string()]).optional(),
  notes: z.string().optional(),
  status: z.enum(['new', 'contacted', 'qualified', 'converted', 'lost']).optional().default('new'),
  origin: z.string().optional(),
  segment_id: z.string().uuid().optional(),
  campaign_id: z.string().uuid().optional(),
  assignee_id: z.string().uuid().optional(),
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
    const validated = CreateLeadSchema.parse(body);
    const effectiveUserId = await resolveUserId(validated.site_id, validated.user_id);

    const lead = await createLead({
      name: validated.name,
      email: validated.email,
      site_id: validated.site_id,
      user_id: effectiveUserId,
      phone: validated.phone,
      position: validated.position,
      company: validated.company,
      notes: validated.notes,
      status: validated.status,
      origin: validated.origin,
      segment_id: validated.segment_id,
      campaign_id: validated.campaign_id,
      assignee_id: validated.assignee_id,
    });

    return NextResponse.json({
      success: true,
      lead,
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
