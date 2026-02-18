import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const UpdateAssetSchema = z.object({
  asset_id: z.string().uuid('Valid asset_id required'),
  site_id: z.string().uuid('Site ID is required'),
  name: z.string().optional(),
  file_type: z.string().optional(),
  content: z.string().optional(),
  metadata: z.any().optional(),
});

export async function updateAssetCore(input: any) {
  const validated = UpdateAssetSchema.parse(input);

  // Verificar que el asset existe y pertenece al sitio
  const { data: existingAsset, error: fetchError } = await supabaseAdmin
    .from('assets')
    .select('site_id')
    .eq('id', validated.asset_id)
    .single();

  if (fetchError || !existingAsset) {
    throw new Error('Asset not found');
  }

  if (existingAsset.site_id !== validated.site_id) {
    throw new Error('No tienes permiso para actualizar este asset');
  }

  const updates: any = {};
  if (validated.name !== undefined) updates.name = validated.name;
  if (validated.file_type !== undefined) updates.file_type = validated.file_type;
  if (validated.content !== undefined) updates.content = validated.content;
  if (validated.metadata !== undefined) updates.metadata = validated.metadata;

  if (Object.keys(updates).length === 0) {
    return { message: 'No updates provided' };
  }

  updates.updated_at = new Date().toISOString();

  const { data: asset, error } = await supabaseAdmin
    .from('assets')
    .update(updates)
    .eq('id', validated.asset_id)
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return asset;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const asset = await updateAssetCore(body);

    return NextResponse.json({
      success: true,
      asset,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid input',
        details: error.errors,
      }, { status: 400 });
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'Asset not found') {
      return NextResponse.json({ success: false, error: errorMessage }, { status: 404 });
    }
    if (errorMessage === 'No tienes permiso para actualizar este asset') {
      return NextResponse.json({ success: false, error: errorMessage }, { status: 403 });
    }

    return NextResponse.json({
      success: false,
      error: errorMessage,
    }, { status: 500 });
  }
}
