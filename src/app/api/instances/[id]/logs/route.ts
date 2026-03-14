import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// GET /api/instances/[id]/logs
// Retrieves logs for a specific instance, with optional pagination and filtering
// ------------------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: 'El parámetro id es requerido' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const logType = searchParams.get('log_type');
    const level = searchParams.get('level');

    // Verify instance exists
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('id')
      .eq('id', id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json(
        { error: 'Instancia no encontrada' },
        { status: 404 }
      );
    }

    // Query logs
    let query = supabaseAdmin
      .from('instance_logs')
      .select('*')
      .eq('instance_id', id)
      .order('created_at', { ascending: false });

    if (logType) {
      query = query.eq('log_type', logType);
    }
    if (level) {
      query = query.eq('level', level);
    }

    const { data: logs, error: logsError } = await query
      .range(offset, offset + limit - 1);

    if (logsError) {
      console.error('Error fetching logs:', logsError.message);
      return NextResponse.json(
        { error: 'Error al obtener los logs' },
        { status: 500 }
      );
    }

    return NextResponse.json({ logs, limit, offset }, { status: 200 });
  } catch (err: any) {
    console.error('Error in GET /api/instances/[id]/logs:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ------------------------------------------------------------------------------------
// POST /api/instances/[id]/logs
// Creates a new log for the instance
// ------------------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

    const payload = await request.json();

    const { data: log, error } = await supabaseAdmin
      .from('instance_logs')
      .insert({ ...payload, instance_id: id })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ log, message: 'Log creado correctamente' }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
