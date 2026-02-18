import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const UpdateSaleSchema = z.object({
  sale_id: z.string().uuid(),
  site_id: z.string().uuid('Site ID is required'),
  status: z.string().optional(),
  notes: z.string().optional(),
  payment_method: z.string().optional(),
  total_amount: z.number().positive().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = UpdateSaleSchema.parse(body);
    const { sale_id, site_id, ...updateFields } = validatedData;

    // Verificar que la venta existe y pertenece al sitio
    const { data: existingSale, error: fetchError } = await supabaseAdmin
      .from('sales')
      .select('site_id')
      .eq('id', sale_id)
      .single();

    if (fetchError || !existingSale) {
      return NextResponse.json({ success: false, error: 'Sale not found' }, { status: 404 });
    }

    if (existingSale.site_id !== site_id) {
      return NextResponse.json({ success: false, error: 'No tienes permiso para actualizar esta venta' }, { status: 403 });
    }

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('sales')
      .update({
        ...updateFields,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sale_id)
      .select()
      .single();

    if (error) {
      console.error('Error updating sale:', error);
      return NextResponse.json({ success: false, error: 'Failed to update sale' }, { status: 500 });
    }

    return NextResponse.json({ success: true, sale: data }, { status: 200 });

  } catch (error) {
    console.error('[UpdateSale] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
