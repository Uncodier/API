import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const DeleteOrderSchema = z.object({
  order_id: z.string().uuid(),
  site_id: z.string().uuid('Site ID is required'),
});

/**
 * Endpoint to delete a sales order
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { order_id, site_id } = DeleteOrderSchema.parse(body);

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
      return NextResponse.json({ success: false, error: 'No tienes permiso para eliminar esta orden' }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from('orders')
      .delete()
      .eq('id', order_id);

    if (error) {
      console.error('Error deleting order:', error);
      return NextResponse.json({ success: false, error: 'Failed to delete order' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Order deleted successfully' }, { status: 200 });

  } catch (error) {
    console.error('[DeleteSalesOrder] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
