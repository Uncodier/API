import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const GetAssetsSchema = z.object({
  asset_id: z.string().uuid().optional(),
  site_id: z.string().uuid('Site ID is required'),
  instance_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export async function getAssetCore(filters: Record<string, unknown>) {
  const validated = GetAssetsSchema.parse(filters);

  if (validated.asset_id) {
    const { data: asset, error } = await supabaseAdmin
      .from('assets')
      .select('*')
      .eq('id', validated.asset_id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return { success: true, data: { asset: null } };
      throw new Error(error.message);
    }

    if (asset.site_id !== validated.site_id) {
      throw new Error('No tienes permiso para ver este asset');
    }

    return {
      success: true,
      data: {
        asset,
      },
    };
  }

  let query = supabaseAdmin
    .from('assets')
    .select('*', { count: 'exact' })
    .eq('site_id', validated.site_id);

  if (validated.instance_id) query = query.eq('instance_id', validated.instance_id);

  const { data: assets, error, count } = await query
    .range(validated.offset, validated.offset + validated.limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return {
    success: true,
    data: {
      assets,
      pagination: {
        total: count,
        count: assets.length,
        offset: validated.offset,
        limit: validated.limit,
        has_more: (count || 0) > validated.offset + assets.length,
      },
    },
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getAssetCore(body);
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
