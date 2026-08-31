import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const ALLOWED_TYPES = ['fixed', 'variable'];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, limit = 50, offset = 0, user_id, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'create') {
      if (!site_id) {
        return NextResponse.json({ success: false, error: 'Missing site_id' }, { status: 400 });
      }
      if (!user_id) {
        return NextResponse.json({ success: false, error: 'Missing user_id' }, { status: 400 });
      }
      if (!updates.amount && updates.amount !== 0) {
        return NextResponse.json({ success: false, error: 'Missing amount' }, { status: 400 });
      }
      if (Number(updates.amount) <= 0) {
        return NextResponse.json({ success: false, error: 'Amount must be greater than 0' }, { status: 400 });
      }
      if (!updates.type || !ALLOWED_TYPES.includes(updates.type)) {
        return NextResponse.json(
          { success: false, error: `Invalid or missing type. Allowed: ${ALLOWED_TYPES.join(', ')}` },
          { status: 400 }
        );
      }

      const { data, error } = await supabaseAdmin
        .from('transactions')
        .insert({
          site_id,
          user_id,
          type: updates.type,
          amount: Number(updates.amount),
          description: updates.description || null,
          date: updates.date || new Date().toISOString().slice(0, 10),
          currency: updates.currency || 'USD',
          category: updates.category || null,
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, transaction: data });
    }

    if (action === 'update') {
      if (!id || !site_id) {
        return NextResponse.json({ success: false, error: 'Missing id or site_id' }, { status: 400 });
      }

      if (updates.type && !ALLOWED_TYPES.includes(updates.type)) {
        return NextResponse.json(
          { success: false, error: `Invalid type. Allowed: ${ALLOWED_TYPES.join(', ')}` },
          { status: 400 }
        );
      }

      const payload: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      
      if (updates.type !== undefined) payload.type = updates.type;
      if (updates.amount !== undefined) payload.amount = Number(updates.amount);
      if (updates.description !== undefined) payload.description = updates.description;
      if (updates.date !== undefined) payload.date = updates.date;
      if (updates.currency !== undefined) payload.currency = updates.currency;
      if (updates.category !== undefined) payload.category = updates.category;

      const { data, error } = await supabaseAdmin
        .from('transactions')
        .update(payload)
        .eq('id', id)
        .eq('site_id', site_id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, transaction: data });
    }

    if (action === 'get') {
      if (!id || !site_id) {
        return NextResponse.json({ success: false, error: 'Missing id or site_id' }, { status: 400 });
      }

      const { data, error } = await supabaseAdmin
        .from('transactions')
        .select('*')
        .eq('id', id)
        .eq('site_id', site_id)
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, transaction: data });
    }

    if (action === 'list') {
      let query = supabaseAdmin
        .from('transactions')
        .select('*', { count: 'exact' });

      if (site_id) query = query.eq('site_id', site_id);
      if (updates.type) query = query.eq('type', updates.type);
      if (updates.category) query = query.eq('category', updates.category);
      if (updates.currency) query = query.eq('currency', updates.currency);

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, transactions: data, count });
    }

    if (action === 'delete') {
      if (!id || !site_id) {
        return NextResponse.json({ success: false, error: 'Missing id or site_id' }, { status: 400 });
      }

      const { error } = await supabaseAdmin
        .from('transactions')
        .delete()
        .eq('id', id)
        .eq('site_id', site_id);

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Transactions tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
