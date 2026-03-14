import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// GET /api/instances/[id]
// Retrieves a specific remote instance by its ID
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

    const { data: instance, error } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !instance) {
      console.error('Error fetching instance:', error?.message);
      return NextResponse.json(
        { error: 'Instancia no encontrada' },
        { status: 404 }
      );
    }

    return NextResponse.json({ instance }, { status: 200 });
  } catch (err: any) {
    console.error('Error in GET /api/instances/[id]:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ------------------------------------------------------------------------------------
// PUT /api/instances/[id]
// Updates a specific remote instance by its ID
// ------------------------------------------------------------------------------------

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

    const payload = await request.json();

    const { data: instance, error } = await supabaseAdmin
      .from('remote_instances')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ instance, message: 'Instancia actualizada correctamente' }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ------------------------------------------------------------------------------------
// DELETE /api/instances/[id]
// Deletes a specific remote instance by its ID
// ------------------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

    const { error } = await supabaseAdmin
      .from('remote_instances')
      .delete()
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ message: 'Instancia eliminada correctamente' }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
