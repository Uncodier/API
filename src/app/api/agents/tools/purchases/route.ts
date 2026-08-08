import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const ALLOWED_STATUSES = ['draft', 'pending', 'completed', 'cancelled'];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, limit = 50, offset = 0, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'create') {
      if (!site_id) {
        return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
      }
      if (!updates.title) {
        return NextResponse.json({ success: false, error: 'Missing title' }, { status: 400 });
      }

      const status = updates.status || 'draft';
      if (!ALLOWED_STATUSES.includes(status)) {
        return NextResponse.json(
          { success: false, error: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}` },
          { status: 400 }
        );
      }

      const { data, error } = await supabaseAdmin
        .from('purchases')
        .insert({
          site_id,
          title: updates.title,
          vendor_company_id: updates.vendor_company_id || null,
          status,
          amount: 0,
          amount_due: updates.amount_due !== undefined ? Number(updates.amount_due) : 0,
          currency: updates.currency || 'USD',
          payments: [],
          purchase_date: updates.purchase_date || new Date().toISOString().slice(0, 10),
          location_id: updates.location_id || null,
          accounting_state: 'pending',
          stock_received: false,
          notes: updates.notes || null,
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, purchase: data });
    }

    if (action === 'update') {
      if (!id || !site_id) {
        return NextResponse.json({ success: false, error: 'Missing id or site_id' }, { status: 400 });
      }

      if (updates.status && !ALLOWED_STATUSES.includes(updates.status)) {
        return NextResponse.json(
          { success: false, error: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}` },
          { status: 400 }
        );
      }

      const payload: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (updates.title !== undefined) payload.title = updates.title;
      if (updates.vendor_company_id !== undefined) payload.vendor_company_id = updates.vendor_company_id;
      if (updates.status !== undefined) payload.status = updates.status;
      if (updates.amount_due !== undefined) payload.amount_due = Number(updates.amount_due);
      if (updates.currency !== undefined) payload.currency = updates.currency;
      if (updates.purchase_date !== undefined) payload.purchase_date = updates.purchase_date;
      if (updates.location_id !== undefined) payload.location_id = updates.location_id;
      if (updates.notes !== undefined) payload.notes = updates.notes;

      const { data, error } = await supabaseAdmin
        .from('purchases')
        .update(payload)
        .eq('id', id)
        .eq('site_id', site_id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, purchase: data });
    }

    if (action === 'get') {
      if (!id || !site_id) {
        return NextResponse.json({ success: false, error: 'Missing id or site_id' }, { status: 400 });
      }

      const { data, error } = await supabaseAdmin
        .from('purchases')
        .select(`
          *,
          vendor:companies!vendor_company_id(id, name),
          purchase_items(*)
        `)
        .eq('id', id)
        .eq('site_id', site_id)
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, purchase: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('purchases')
        .select('*, vendor:companies!vendor_company_id(id, name)', { count: 'exact' });

      if (site_id) query = query.eq('site_id', site_id);
      if (updates.status) query = query.eq('status', updates.status);
      if (updates.vendor_company_id) query = query.eq('vendor_company_id', updates.vendor_company_id);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('purchase_date', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, purchases: data, count });
    }

    if (action === 'delete') {
      if (!id || !site_id) {
        return NextResponse.json({ success: false, error: 'Missing id or site_id' }, { status: 400 });
      }

      const { error } = await supabaseAdmin
        .from('purchases')
        .delete()
        .eq('id', id)
        .eq('site_id', site_id);

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true });
    }

    if (action === 'register_payment') {
      if (!id || !site_id) {
        return NextResponse.json({ success: false, error: 'Missing id or site_id' }, { status: 400 });
      }

      const amount = Number(updates.amount);
      if (!amount || amount <= 0) {
        return NextResponse.json({ success: false, error: 'Invalid payment amount' }, { status: 400 });
      }
      if (!updates.method) {
        return NextResponse.json({ success: false, error: 'Missing payment method' }, { status: 400 });
      }

      const { data: purchase, error: fetchError } = await supabaseAdmin
        .from('purchases')
        .select('*')
        .eq('id', id)
        .eq('site_id', site_id)
        .single();

      if (fetchError || !purchase) {
        throw new Error(fetchError?.message || 'Purchase not found');
      }

      const amountDue = Number(purchase.amount_due) || 0;
      if (amount > amountDue) {
        return NextResponse.json(
          { success: false, error: 'Payment amount cannot exceed amount due' },
          { status: 400 }
        );
      }

      const payment = {
        id: `payment-${Date.now()}`,
        date: new Date().toISOString(),
        amount,
        method: updates.method,
        notes: updates.payment_notes || undefined,
      };

      const newAmountDue = Math.max(0, amountDue - amount);
      const status =
        newAmountDue === 0 && purchase.status !== 'cancelled' ? 'completed' : purchase.status;
      const payments = [...(purchase.payments || []), payment];

      const { data, error } = await supabaseAdmin
        .from('purchases')
        .update({
          amount_due: newAmountDue,
          payments,
          status,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('site_id', site_id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, purchase: data });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Purchases tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
