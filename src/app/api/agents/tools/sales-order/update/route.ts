import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const UpdateOrderSchema = z.object({
  order_id: z.string().uuid(),
  site_id: z.string().uuid('Site ID is required'),
  status: z.string().optional(),
  delivery_date: z.string().optional(),
  shipping_method: z.string().optional(),
  priority: z.string().optional(),
  shipping_address: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
});

/**
 * Endpoint to update a sales order
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = UpdateOrderSchema.parse(body);
    const { order_id, site_id, ...updateFields } = validatedData;

    // Verificar que la orden existe y pertenece al sitio
    const { data: existingOrder, error: fetchError } = await supabaseAdmin
      .from('orders')
      .select('site_id')
      .eq('id', order_id)
      .single();

    if (fetchError || !existingOrder) {
      return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
    }

    if (existingOrder.site_id !== site_id) {
      return NextResponse.json({ success: false, error: 'No tienes permiso para actualizar esta orden' }, { status: 403 });
    }

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({
        ...updateFields,
        updated_at: new Date().toISOString(),
      })
      .eq('id', order_id)
      .select()
      .single();

    if (error) {
      console.error('Error updating order:', error);
      return NextResponse.json({ success: false, error: 'Failed to update order' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      order: data
    }, { status: 200 });

  } catch (error) {
    console.error('[UpdateSalesOrder] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
