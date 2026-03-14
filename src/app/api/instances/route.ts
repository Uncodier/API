import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

// ------------------------------------------------------------------------------------
// GET /api/instances
// Lists remote instances with optional filtering and pagination
// ------------------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const site_id = searchParams.get('site_id');
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    let query = supabaseAdmin
      .from('remote_instances')
      .select('*')
      .order('created_at', { ascending: false });

    if (site_id) {
      query = query.eq('site_id', site_id);
    }
    if (status) {
      query = query.eq('status', status);
    }

    const { data: instances, error } = await query
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Error fetching instances:', error.message);
      return NextResponse.json(
        { error: 'Error al obtener las instancias' },
        { status: 500 }
      );
    }

    return NextResponse.json({ instances, limit, offset }, { status: 200 });
  } catch (err: any) {
    console.error('Error in GET /api/instances:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

const CreateInstanceSchema = z.object({
  name: z.string().min(1, 'name es requerido'),
  instance_type: z.enum(['ubuntu', 'browser', 'windows']).default('browser'),
  status: z.enum(['pending', 'starting', 'running', 'paused', 'stopping', 'stopped', 'error']).default('pending'),
  provider_instance_id: z.string().optional(),
  cdp_url: z.string().optional(),
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  user_id: z.string().uuid('user_id debe ser un UUID válido'),
  agent_id: z.string().uuid().optional(),
  configuration: z.any().optional(),
  environment_variables: z.any().optional()
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const body = CreateInstanceSchema.parse(rawBody);

    const payload = {
      ...body,
      created_by: body.user_id // using user_id as created_by
    };

    const { data: instance, error } = await supabaseAdmin
      .from('remote_instances')
      .insert(payload)
      .select()
      .single();

    if (error) {
      console.error('Error creating instance:', error.message);
      return NextResponse.json(
        { error: 'Error al crear la instancia', details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ instance, message: 'Instancia creada correctamente' }, { status: 201 });
  } catch (err: any) {
    console.error('Error in POST /api/instances:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validación fallida', details: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
