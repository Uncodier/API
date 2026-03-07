import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const DeleteDealSchema = z.object({
  deal_id: z.string().uuid(),
  site_id: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { deal_id, site_id } = DeleteDealSchema.parse(body);

    const { error } = await supabaseAdmin
      .from('deals')
      .delete()
      .eq('id', deal_id)
      .eq('site_id', site_id);

    if (error) {
      console.error('Error deleting deal:', error);
      return NextResponse.json({ success: false, error: 'Failed to delete deal' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Deal deleted successfully' });
  } catch (error) {
    console.error('[DeleteDeal] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
