import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

async function recalculatePurchaseTotals(purchaseId: string) {
  const { data: items } = await supabaseAdmin
    .from('purchase_items')
    .select('subtotal')
    .eq('purchase_id', purchaseId);

  const amount =
    Math.round((items || []).reduce((acc: number, item: any) => acc + (Number(item.subtotal) || 0), 0) * 100) /
    100;

  const { data: current } = await supabaseAdmin
    .from('purchases')
    .select('amount_due')
    .eq('id', purchaseId)
    .single();

  const currentDue = Number(current?.amount_due) || 0;
  const amount_due = Math.min(currentDue, amount);

  await supabaseAdmin
    .from('purchases')
    .update({
      amount,
      amount_due,
      updated_at: new Date().toISOString(),
    })
    .eq('id', purchaseId);

  return { amount, amount_due };
}

async function verifyPurchaseOwnership(purchaseId: string, site_id?: string) {
  const { data } = await supabaseAdmin
    .from('purchases')
    .select('id, site_id')
    .eq('id', purchaseId)
    .single();

  if (!data) {
    throw new Error('Purchase not found');
  }
  if (site_id && data.site_id !== site_id) {
    throw new Error('Unauthorized or purchase not found');
  }
  return data;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, limit = 50, offset = 0, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'create') {
      if (!updates.purchase_id) {
        return NextResponse.json({ success: false, error: 'Missing purchase_id' }, { status: 400 });
      }

      const purchase = await verifyPurchaseOwnership(updates.purchase_id, site_id);

      let finalName = updates.name;
      let finalCost = updates.unit_cost;

      if (updates.catalog_item_id && (!finalName || finalCost === undefined)) {
        const { data: cat } = await supabaseAdmin
          .from('catalog_items')
          .select('name, cost')
          .eq('id', updates.catalog_item_id)
          .single();

        if (cat) {
          if (!finalName) finalName = cat.name;
          if (finalCost === undefined) finalCost = Number(cat.cost) || 0;
        }
      }

      if (!finalName) {
        throw new Error('Missing required field: name (could not be inferred)');
      }

      const quantity = updates.quantity ?? 1;
      const unit_cost = finalCost ?? 0;
      const subtotal = Math.round(quantity * unit_cost * 100) / 100;

      const { data, error } = await supabaseAdmin
        .from('purchase_items')
        .insert({
          purchase_id: updates.purchase_id,
          site_id: purchase.site_id,
          catalog_item_id: updates.catalog_item_id || null,
          name: finalName,
          quantity,
          unit_cost,
          subtotal,
        })
        .select()
        .single();

      if (error) throw new Error(error.message);

      const totals = await recalculatePurchaseTotals(updates.purchase_id);
      return NextResponse.json({ success: true, item: data, purchase_totals: totals });
    }

    if (action === 'update') {
      if (!id) {
        return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
      }

      const { data: current } = await supabaseAdmin.from('purchase_items').select('*').eq('id', id).single();
      if (!current) throw new Error('Item not found');
      await verifyPurchaseOwnership(current.purchase_id, site_id);

      const quantity = updates.quantity ?? current.quantity;
      const unit_cost = updates.unit_cost ?? current.unit_cost;
      const subtotal = Math.round(Number(quantity) * Number(unit_cost) * 100) / 100;

      const payload: Record<string, unknown> = {
        quantity,
        unit_cost,
        subtotal,
        updated_at: new Date().toISOString(),
      };
      if (updates.name !== undefined) payload.name = updates.name;
      if (updates.catalog_item_id !== undefined) payload.catalog_item_id = updates.catalog_item_id;

      const { data, error } = await supabaseAdmin
        .from('purchase_items')
        .update(payload)
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(error.message);

      const totals = await recalculatePurchaseTotals(data.purchase_id);
      return NextResponse.json({ success: true, item: data, purchase_totals: totals });
    }

    if (action === 'list') {
      if (!updates.purchase_id) {
        return NextResponse.json({ success: false, error: 'purchase_id required for list' }, { status: 400 });
      }
      await verifyPurchaseOwnership(updates.purchase_id, site_id);

      const { data, error, count } = await supabaseAdmin
        .from('purchase_items')
        .select('*', { count: 'exact' })
        .eq('purchase_id', updates.purchase_id)
        .range(offset, offset + limit - 1);

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, items: data, count });
    }

    if (action === 'delete') {
      if (!id) {
        return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
      }

      const { data: current } = await supabaseAdmin
        .from('purchase_items')
        .select('purchase_id')
        .eq('id', id)
        .single();
      if (!current) throw new Error('Item not found');
      await verifyPurchaseOwnership(current.purchase_id, site_id);

      const { error } = await supabaseAdmin.from('purchase_items').delete().eq('id', id);
      if (error) throw new Error(error.message);

      const totals = await recalculatePurchaseTotals(current.purchase_id);
      return NextResponse.json({ success: true, purchase_totals: totals });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Purchase Items tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
