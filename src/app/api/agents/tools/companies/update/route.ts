import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const UpdateCompanySchema = z.object({
  company_id: z.string().uuid(),
  name: z.string().optional(),
  website: z.string().optional(),
  industry: z.string().optional(),
  size: z.string().optional(),
  description: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  linkedin_url: z.string().optional(),
  employees_count: z.number().optional(),
  annual_revenue: z.string().optional(),
  founded: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = UpdateCompanySchema.parse(body);
    const { company_id, ...updateFields } = validatedData;

    if (Object.keys(updateFields).length > 0) {
      const { error: updateError } = await supabaseAdmin
        .from('companies')
        .update({
          ...updateFields,
          updated_at: new Date().toISOString()
        })
        .eq('id', company_id);

      if (updateError) {
        console.error('Error updating company:', updateError);
        return NextResponse.json({ success: false, error: 'Failed to update company' }, { status: 500 });
      }
    }

    const { data: updatedCompany } = await supabaseAdmin
      .from('companies')
      .select('*')
      .eq('id', company_id)
      .single();

    return NextResponse.json({ success: true, company: updatedCompany });

  } catch (error) {
    console.error('[UpdateCompany] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
