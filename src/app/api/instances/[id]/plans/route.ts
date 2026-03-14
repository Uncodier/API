import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// GET /api/instances/[id]/plans
// Retrieves plans for a specific instance
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
    const status = searchParams.get('status');
    const planType = searchParams.get('plan_type');

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

    // Query plans
    let query = supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('instance_id', id)
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (planType) query = query.eq('plan_type', planType);

    const { data: plans, error: plansError } = await query
      .range(offset, offset + limit - 1);

    if (plansError) {
      console.error('Error fetching plans:', plansError.message);
      return NextResponse.json(
        { error: 'Error al obtener los planes' },
        { status: 500 }
      );
    }

    return NextResponse.json({ plans, limit, offset }, { status: 200 });
  } catch (err: any) {
    console.error('Error in GET /api/instances/[id]/plans:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ------------------------------------------------------------------------------------
// POST /api/instances/[id]/plans
// Creates a new plan for the instance
// ------------------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

    const payload = await request.json();

    const { data: plan, error } = await supabaseAdmin
      .from('instance_plans')
      .insert({ ...payload, instance_id: id })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ plan, message: 'Plan creado correctamente' }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
