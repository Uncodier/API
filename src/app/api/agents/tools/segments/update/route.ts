import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const UpdateSegmentSchema = z.object({
  segment_id: z.string().uuid('Valid segment_id required'),
  site_id: z.string().uuid('Site ID is required'),
  name: z.string().optional(),
  description: z.string().optional(),
  audience: z.string().optional(),
  size: z.number().optional(),
  estimated_value: z.number().optional(),
  language: z.string().optional(),
  is_active: z.boolean().optional(),
  attributes: z.record(z.any()).optional(),
  analysis: z.array(z.any()).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = UpdateSegmentSchema.parse(body);

    // Verificar que el segmento existe y pertenece al sitio
    const { data: existingSegment, error: fetchError } = await supabaseAdmin
      .from('segments')
      .select('site_id')
      .eq('id', validated.segment_id)
      .single();

    if (fetchError || !existingSegment) {
      return NextResponse.json({ success: false, error: 'Segment not found' }, { status: 404 });
    }

    if (existingSegment.site_id !== validated.site_id) {
      return NextResponse.json({ success: false, error: 'No tienes permiso para actualizar este segmento' }, { status: 403 });
    }

    const updates: any = {};
    if (validated.name !== undefined) updates.name = validated.name;
    if (validated.description !== undefined) updates.description = validated.description;
    if (validated.audience !== undefined) updates.audience = validated.audience;
    if (validated.size !== undefined) updates.size = validated.size;
    if (validated.estimated_value !== undefined) updates.estimated_value = validated.estimated_value;
    if (validated.language !== undefined) updates.language = validated.language;
    if (validated.is_active !== undefined) updates.is_active = validated.is_active;
    
    // For analysis, we might want to append or replace. Let's replace for now if provided.
    // If attributes provided but not analysis, wrap in analysis structure
    if (validated.analysis !== undefined) {
      updates.analysis = validated.analysis;
    } else if (validated.attributes !== undefined) {
      // Need to fetch existing analysis if we want to merge? Or just replace?
      // Assuming simple replacement or addition based on typical usage.
      updates.analysis = [{ type: 'attributes', data: validated.attributes }];
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: true, message: 'No updates provided' });
    }

    updates.updated_at = new Date().toISOString();

    const { data: segment, error } = await supabaseAdmin
      .from('segments')
      .update(updates)
      .eq('id', validated.segment_id)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      success: true,
      segment,
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
