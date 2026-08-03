import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

async function recalculateTotals(quotationId: string) {
  const { data: items } = await supabaseAdmin.from('quotation_items').select('subtotal').eq('quotation_id', quotationId);
  const total = (items || []).reduce((acc: number, item: any) => acc + (Number(item.subtotal) || 0), 0);
  
  await supabaseAdmin.from('quotations').update({
    subtotal: total,
    total: total,
    tax_total: 0,
    discount_total: 0
  }).eq('id', quotationId);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, limit = 50, offset = 0, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    // Helper to verify site ownership
    async function verifyQuotationOwnership(quotationId: string) {
      if (!site_id) return true;
      const { data } = await supabaseAdmin.from('quotations').select('site_id').eq('id', quotationId).single();
      if (!data || data.site_id !== site_id) {
        throw new Error('Unauthorized or quotation not found');
      }
      return true;
    }

    if (action === 'create') {
      await verifyQuotationOwnership(updates.quotation_id);
      
      let finalName = updates.name;
      let finalPrice = updates.unit_price;

      // Hydrate name/price from catalog if catalog_item_id is provided but name/price are missing
      if (updates.catalog_item_id && (!finalName || finalPrice === undefined)) {
        // Find if quotation has a price_list_id
        const { data: quote } = await supabaseAdmin.from('quotations').select('price_list_id').eq('id', updates.quotation_id).single();
        
        let customPrice: number | undefined;
        if (quote?.price_list_id) {
          const { data: pli } = await supabaseAdmin.from('price_list_items')
            .select('unit_price')
            .eq('price_list_id', quote.price_list_id)
            .eq('catalog_item_id', updates.catalog_item_id)
            .maybeSingle();
          if (pli) customPrice = Number(pli.unit_price);
        }

        const { data: cat } = await supabaseAdmin.from('catalog_items')
          .select('name, target_sale_price')
          .eq('id', updates.catalog_item_id)
          .single();
          
        if (cat) {
          if (!finalName) finalName = cat.name;
          if (finalPrice === undefined) finalPrice = customPrice !== undefined ? customPrice : (cat.target_sale_price || 0);
        }
      }

      if (!finalName) throw new Error('Missing required field: name (could not be inferred)');
      
      const quantity = updates.quantity || 1;
      const unit_price = finalPrice || 0;
      const subtotal = quantity * unit_price;

      const { data, error } = await supabaseAdmin
        .from('quotation_items')
        .insert({
          quotation_id: updates.quotation_id,
          catalog_item_id: updates.catalog_item_id,
          name: finalName,
          quantity,
          unit_price,
          subtotal,
          metadata: updates.metadata
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      await recalculateTotals(updates.quotation_id);
      return NextResponse.json({ success: true, item: data });
    }

    if (action === 'update') {
      const { data: current } = await supabaseAdmin.from('quotation_items').select('*').eq('id', id).single();
      if (!current) throw new Error('Item not found');
      await verifyQuotationOwnership(current.quotation_id);

      const quantity = updates.quantity ?? current.quantity;
      const unit_price = updates.unit_price ?? current.unit_price;
      const subtotal = quantity * unit_price;

      const { data, error } = await supabaseAdmin
        .from('quotation_items')
        .update({
          quantity,
          unit_price,
          subtotal,
          metadata: updates.metadata
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      await recalculateTotals(data.quotation_id);
      return NextResponse.json({ success: true, item: data });
    }

    if (action === 'list') {
      if (!updates.quotation_id) throw new Error('quotation_id required for list');
      await verifyQuotationOwnership(updates.quotation_id);
      
      const { data, error, count } = await supabaseAdmin
        .from('quotation_items')
        .select('*', { count: 'exact' })
        .eq('quotation_id', updates.quotation_id)
        .range(offset, offset + limit - 1);

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, items: data, count });
    }

    if (action === 'delete') {
      const { data: current } = await supabaseAdmin.from('quotation_items').select('quotation_id').eq('id', id).single();
      if (!current) throw new Error('Item not found');
      await verifyQuotationOwnership(current.quotation_id);

      const { error } = await supabaseAdmin
        .from('quotation_items')
        .delete()
        .eq('id', id);

      if (error) throw new Error(error.message);
      await recalculateTotals(current.quotation_id);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Quotation Items tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
