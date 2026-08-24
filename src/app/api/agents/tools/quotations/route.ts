import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, limit = 50, offset = 0, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'create') {
      const { data, error } = await supabaseAdmin
        .from('quotations')
        .insert({
          site_id,
          deal_id: updates.deal_id,
          lead_id: updates.lead_id,
          buyer_user_id: updates.buyer_user_id,
          price_list_id: updates.price_list_id,
          status: updates.status || 'draft',
          valid_until: updates.valid_until || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          currency: updates.currency || 'USD',
          notes: updates.notes
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      if (data && site_id) {
        const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
        fireWorkflowDispatch({ table: 'quotations', op: 'insert', row: data, site_id });
      }
      return NextResponse.json({ success: true, quotation: data });
    }

    if (action === 'update') {
      if (updates.status === 'accepted') {
        return NextResponse.json(
          {
            success: false,
            error:
              'Cannot set status=accepted via this tool. Use buyer accept/checkout flow instead.',
          },
          { status: 400 }
        );
      }

      const allowedStatuses = ['draft', 'sent', 'rejected', 'expired'];
      if (updates.status && !allowedStatuses.includes(updates.status)) {
        return NextResponse.json(
          {
            success: false,
            error: `Invalid status. Allowed: ${allowedStatuses.join(', ')}`,
          },
          { status: 400 }
        );
      }

      const payload: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (updates.status !== undefined) payload.status = updates.status;
      if (updates.valid_until !== undefined) payload.valid_until = updates.valid_until;
      if (updates.notes !== undefined) payload.notes = updates.notes;
      if (updates.buyer_user_id !== undefined) payload.buyer_user_id = updates.buyer_user_id;
      if (updates.price_list_id !== undefined) payload.price_list_id = updates.price_list_id;

      const { data, error } = await supabaseAdmin
        .from('quotations')
        .update(payload)
        .eq('id', id)
        .eq('site_id', site_id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      if (data && site_id) {
        const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
        fireWorkflowDispatch({ table: 'quotations', op: 'update', row: data, site_id });
      }
      return NextResponse.json({ success: true, quotation: data });
    }

    if (action === 'get') {
      const { data, error } = await supabaseAdmin
        .from('quotations')
        .select('*, items:quotation_items(*)')
        .eq('id', id)
        .eq('site_id', site_id)
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, quotation: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('quotations')
        .select('*', { count: 'exact' });

      if (site_id) query = query.eq('site_id', site_id);
      if (updates.lead_id) query = query.eq('lead_id', updates.lead_id);
      if (updates.deal_id) query = query.eq('deal_id', updates.deal_id);
      if (updates.status) query = query.eq('status', updates.status);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, quotations: data, count });
    }

    if (action === 'delete') {
      const { error } = await supabaseAdmin
        .from('quotations')
        .delete()
        .eq('id', id)
        .eq('site_id', site_id);

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Quotations tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
