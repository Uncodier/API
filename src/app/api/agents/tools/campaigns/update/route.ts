import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const UpdateCampaignSchema = z.object({
  campaign_id: z.string().uuid('Valid campaign_id required'),
  site_id: z.string().uuid('Site ID is required'),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  priority: z.string().optional(),
  budget: z.any().optional(),
  revenue: z.any().optional(),
  due_date: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = UpdateCampaignSchema.parse(body);

    // Verificar que la campaña existe y pertenece al sitio
    const { data: existingCampaign, error: fetchError } = await supabaseAdmin
      .from('campaigns')
      .select('site_id')
      .eq('id', validated.campaign_id)
      .single();

    if (fetchError || !existingCampaign) {
      return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 });
    }

    if (existingCampaign.site_id !== validated.site_id) {
      return NextResponse.json({ success: false, error: 'No tienes permiso para actualizar esta campaña' }, { status: 403 });
    }

    const updates: any = {};
    if (validated.title !== undefined) updates.title = validated.title;
    if (validated.description !== undefined) updates.description = validated.description;
    if (validated.status !== undefined) updates.status = validated.status;
    if (validated.type !== undefined) updates.type = validated.type;
    if (validated.priority !== undefined) updates.priority = validated.priority;
    if (validated.budget !== undefined) updates.budget = validated.budget;
    if (validated.revenue !== undefined) updates.revenue = validated.revenue;
    if (validated.due_date !== undefined) updates.due_date = validated.due_date;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: true, message: 'No updates provided' });
    }

    updates.updated_at = new Date().toISOString();

    const { data: campaign, error } = await supabaseAdmin
      .from('campaigns')
      .update(updates)
      .eq('id', validated.campaign_id)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      success: true,
      campaign,
    });
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
