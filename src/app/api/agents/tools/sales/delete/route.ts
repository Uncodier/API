import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const DeleteSaleSchema = z.object({
  sale_id: z.string().uuid(),
});

/**
 * Endpoint to delete a sale
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sale_id } = DeleteSaleSchema.parse(body);

    // First delete sale items to maintain referential integrity if needed
    // (Though if there are foreign key constraints with cascade, this might not be strictly necessary)
    await supabaseAdmin
      .from('sale_items')
      .delete()
      .eq('sale_id', sale_id);

    const { error } = await supabaseAdmin
      .from('sales')
      .delete()
      .eq('id', sale_id);

    if (error) {
      console.error('Error deleting sale:', error);
      return NextResponse.json({ success: false, error: 'Failed to delete sale' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Sale deleted successfully' }, { status: 200 });

  } catch (error) {
    console.error('[DeleteSale] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
