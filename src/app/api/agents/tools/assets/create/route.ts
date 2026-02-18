import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const CreateAssetSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  file_type: z.string().min(1, 'File type is required'),
  site_id: z.string().uuid('Site ID is required'),
  instance_id: z.string().uuid('Valid instance_id required'),
  content: z.string().optional(),
  metadata: z.any().optional(),
});

export async function createAssetCore(input: any) {
  const validated = CreateAssetSchema.parse(input);

  // Verificar que la instancia existe y pertenece al sitio
  const { data: instance, error: instanceError } = await supabaseAdmin
    .from('remote_instances')
    .select('site_id')
    .eq('id', validated.instance_id)
    .single();

  if (instanceError) {
    console.error(`[CreateAsset] Error verifying instance in remote_instances: ${instanceError.message}`, instanceError);
    // Don't throw here if just checking, but logic says if error or !instance, 404
  }
  
  if (instanceError || !instance) {
    throw new Error('Instance not found'); // Will catch in POST or caller
  }

  if (instance.site_id !== validated.site_id) {
    throw new Error('La instancia no pertenece a este sitio');
  }

  const assetData = {
    name: validated.name,
    file_type: validated.file_type,
    instance_id: validated.instance_id,
    site_id: validated.site_id,
    content: validated.content,
    metadata: validated.metadata,
  };

  const { data: asset, error } = await supabaseAdmin
    .from('assets')
    .insert(assetData)
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
    
    // We can call the core function. 
    // Note: The core function throws errors, so we catch them here.
    const asset = await createAssetCore(body);

    return NextResponse.json({
      success: true,
      asset,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid input',
        details: error.errors,
      }, { status: 400 });
    }
    
    // Handle specific errors thrown by core
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    if (errorMessage === 'Instance not found') {
       return NextResponse.json({ success: false, error: errorMessage }, { status: 404 });
    }
    if (errorMessage === 'La instancia no pertenece a este sitio') {
       return NextResponse.json({ success: false, error: errorMessage }, { status: 403 });
    }

    return NextResponse.json({
      success: false,
      error: errorMessage,
    }, { status: 500 });
  }
}
