import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const DeleteCompanySchema = z.object({
  company_id: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = DeleteCompanySchema.parse(body);
    const { company_id } = validatedData;

    const { error: deleteError } = await supabaseAdmin
      .from('companies')
      .delete()
      .eq('id', company_id);

    if (deleteError) {
      console.error('Error deleting company:', deleteError);
      return NextResponse.json({ success: false, error: 'Failed to delete company' }, { status: 500 });
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('[DeleteCompany] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
