import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const UpdateDealSchema = z.object({
  deal_id: z.string().uuid(),
  site_id: z.string().uuid(),
  name: z.string().optional(),
  description: z.string().optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  stage: z.enum(['discovery', 'proposal', 'negotiation', 'closed_won', 'closed_lost']).optional(),
  status: z.enum(['open', 'won', 'lost', 'abandoned']).optional(),
  qualification_tier: z.enum(['unqualified', 'exploratory', 'startup', 'smb', 'enterprise']).optional(),
  qualification_score: z.number().min(0).max(100).optional(),
  qualification_details: z.record(z.unknown()).optional(),
  sales_id: z.string().uuid().optional(),
  expected_close_date: z.string().datetime().optional(),
  lead_ids: z.array(z.string().uuid()).optional(),
  owner_ids: z.array(z.string().uuid()).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = UpdateDealSchema.parse(body);
    const { deal_id, lead_ids, owner_ids, site_id, ...updateFields } = validatedData;

    if (Object.keys(updateFields).length > 0) {
      const { error: updateError } = await supabaseAdmin
        .from('deals')
        .update({
          ...updateFields,
          updated_at: new Date().toISOString()
        })
        .eq('id', deal_id)
        .eq('site_id', site_id);

      if (updateError) {
        console.error('Error updating deal:', updateError);
        return NextResponse.json({ success: false, error: 'Failed to update deal' }, { status: 500 });
      }
    }

    if (lead_ids !== undefined) {
      await supabaseAdmin.from('deal_leads').delete().eq('deal_id', deal_id);
      if (lead_ids.length > 0) {
        const dealLeads = lead_ids.map(lead_id => ({ deal_id, lead_id, site_id }));
        await supabaseAdmin.from('deal_leads').insert(dealLeads);
      }
    }

    if (owner_ids !== undefined) {
      await supabaseAdmin.from('deal_owners').delete().eq('deal_id', deal_id);
      if (owner_ids.length > 0) {
        const dealOwners = owner_ids.map(user_id => ({ deal_id, user_id, site_id }));
        await supabaseAdmin.from('deal_owners').insert(dealOwners);
      }
    }

    const { data: updatedDeal } = await supabaseAdmin
      .from('deals')
      .select('*')
      .eq('id', deal_id)
      .single();

    return NextResponse.json({ success: true, deal: updatedDeal });

  } catch (error) {
    console.error('[UpdateDeal] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
