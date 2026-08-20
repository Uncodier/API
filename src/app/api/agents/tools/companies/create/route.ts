import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const CreateCompanySchema = z.object({
  name: z.string(),
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
    const validatedData = CreateCompanySchema.parse(body);

    const { data: company, error: companyError } = await supabaseAdmin
      .from('companies')
      .insert([validatedData])
      .select()
      .single();

    if (companyError) {
      console.error('Error creating company:', companyError);
      return NextResponse.json({ success: false, error: 'Failed to create company' }, { status: 500 });
    }

    return NextResponse.json({ success: true, company }, { status: 201 });

  } catch (error) {
    console.error('[CreateCompany] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
