import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const CreateDealSchema = z.object({
  site_id: z.string().uuid(),
  name: z.string(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  stage: z.string().optional().default('prospecting'),
  status: z.string().optional().default('open'),
  company_id: z.string().uuid().optional(),
  expected_close_date: z.string().optional(),
  notes: z.string().optional(),
  qualification_score: z.number().optional(),
  qualification_criteria: z.record(z.unknown()).optional(),
  sales_order_id: z.string().uuid().optional(),
  lead_ids: z.array(z.string().uuid()).optional(),
  owner_ids: z.array(z.string().uuid()).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = CreateDealSchema.parse(body);
    const { lead_ids, owner_ids, site_id, ...dealDetails } = validatedData;

    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .insert([{
        site_id,
        ...dealDetails
      }])
      .select()
      .single();

    if (dealError) {
      console.error('Error creating deal:', dealError);
      return NextResponse.json({ success: false, error: 'Failed to create deal' }, { status: 500 });
    }

    if (lead_ids && lead_ids.length > 0) {
      const dealLeads = lead_ids.map(lead_id => ({
        deal_id: deal.id,
        lead_id
      }));
      await supabaseAdmin.from('deal_leads').insert(dealLeads);
    }

    if (owner_ids && owner_ids.length > 0) {
      const dealOwners = owner_ids.map(user_id => ({
        deal_id: deal.id,
        user_id
      }));
      await supabaseAdmin.from('deal_owners').insert(dealOwners);
    }

    const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
    fireWorkflowDispatch({
      table: 'deals',
      op: 'insert',
      row: deal as Record<string, unknown>,
      site_id,
    });

    return NextResponse.json({ success: true, deal }, { status: 201 });

  } catch (error) {
    console.error('[CreateDeal] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
