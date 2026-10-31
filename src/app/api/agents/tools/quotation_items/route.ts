import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

async function recalculateTotals(quotationId: string, siteId: string) {
  const { data: items, error } = await supabaseAdmin.from('quotation_items')
    .select('subtotal, quotations!inner(site_id, purpose)')
    .eq('quotation_id', quotationId)
    .eq('quotations.site_id', siteId)
    .eq('quotations.purpose', 'sales');
  if (error) throw new Error(error.message);
  const total = (items || []).reduce((acc: number, item: any) => acc + (Number(item.subtotal) || 0), 0);
  
  const { data: quotation, error: updateError } = await supabaseAdmin.from('quotations').update({
    subtotal: total,
    total: total,
    tax_total: 0,
    discount_total: 0
  }).eq('id', quotationId).eq('site_id', siteId).eq('purpose', 'sales').select('id').single();
  if (updateError) throw new Error(updateError.message);
  if (!quotation) throw new Error('Quotation not found during totals recalculation');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, site_id, limit = 50, offset = 0, ...updates } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (typeof site_id !== 'string' || !site_id.trim()) {
      return NextResponse.json({ success: false, error: 'site_id required' }, { status: 400 });
    }

    if (['get', 'update', 'delete'].includes(action) && (typeof id !== 'string' || !id.trim())) {
      return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    }
    if (['create', 'list'].includes(action) &&
      (typeof updates.quotation_id !== 'string' || !updates.quotation_id.trim())) {
      return NextResponse.json({ success: false, error: 'quotation_id required' }, { status: 400 });
    }
    if (action === 'list' && (!Number.isSafeInteger(limit) || limit < 1 ||
      !Number.isSafeInteger(offset) || offset < 0 || limit - 1 > Number.MAX_SAFE_INTEGER - offset)) {
      return NextResponse.json({ success: false, error: 'Invalid pagination' }, { status: 400 });
    }

    // Service-role reads must exclude procurement before any row is returned.
    async function verifyQuotationOwnership(quotationId: string) {
      if (!quotationId) throw new Error('quotation_id required');
      const { data, error } = await supabaseAdmin.from('quotations')
        .select('id, site_id, price_list_id')
        .eq('id', quotationId).eq('site_id', site_id).eq('purpose', 'sales').single();
      if (error || !data) {
        throw new Error('Unauthorized or quotation not found');
      }
      return data;
    }

    async function getSalesItem() {
      const { data, error } = await supabaseAdmin.from('quotation_items')
        .select('*, quotations!inner(site_id, purpose)')
        .eq('id', id).eq('quotations.site_id', site_id).eq('quotations.purpose', 'sales').single();
      if (error || !data) throw new Error('Item not found');
      const { quotations: _parent, ...item } = data;
      return item;
    }

    if (action === 'create') {
      const quote = await verifyQuotationOwnership(updates.quotation_id);
      
      let finalName = updates.name;
      let finalPrice = updates.unit_price;

      // Validate catalog ownership even when the caller supplies name and price.
      if (updates.catalog_item_id != null) {
        if (typeof updates.catalog_item_id !== 'string' || !updates.catalog_item_id.trim()) {
          return NextResponse.json({ success: false, error: 'Invalid catalog_item_id' }, { status: 400 });
        }
        const { data: cat, error: catalogError } = await supabaseAdmin.from('catalog_items')
          .select('name, target_sale_price')
          .eq('id', updates.catalog_item_id)
          .eq('site_id', site_id)
          .single();
        if (catalogError || !cat) throw new Error('Catalog item not found');
        
        let customPrice: number | undefined;
        if (quote.price_list_id && finalPrice === undefined) {
          const { data: pli, error: priceError } = await supabaseAdmin.from('price_list_items')
            .select('unit_price, price_lists!inner(site_id)')
            .eq('price_list_id', quote.price_list_id)
            .eq('catalog_item_id', updates.catalog_item_id)
            .eq('price_lists.site_id', site_id)
            .maybeSingle();
          if (priceError) throw new Error(priceError.message);
          if (pli) customPrice = Number(pli.unit_price);
        }

        if (!finalName) finalName = cat.name;
        if (finalPrice === undefined) finalPrice = customPrice !== undefined ? customPrice : (cat.target_sale_price || 0);
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
      if (!data) throw new Error('Item was not created');
      await recalculateTotals(updates.quotation_id, site_id);
      return NextResponse.json({ success: true, item: data });
    }

    if (action === 'update') {
      const current = await getSalesItem();
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
        .eq('quotation_id', current.quotation_id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      if (!data) throw new Error('Item not found');
      await recalculateTotals(current.quotation_id, site_id);
      return NextResponse.json({ success: true, item: data });
    }

    if (action === 'get') {
      const item = await getSalesItem();
      return NextResponse.json({ success: true, item });
    }

    if (action === 'list') {
      if (!updates.quotation_id) throw new Error('quotation_id required for list');
      await verifyQuotationOwnership(updates.quotation_id);
      
      const { data, error, count } = await supabaseAdmin
        .from('quotation_items')
        .select('*, quotations!inner(site_id, purpose)', { count: 'exact' })
        .eq('quotation_id', updates.quotation_id)
        .eq('quotations.site_id', site_id)
        .eq('quotations.purpose', 'sales')
        .range(offset, offset + (limit - 1));

      if (error) throw new Error(error.message);
      const salesItems = data?.map(({ quotations: _parent, ...item }) => item);
      return NextResponse.json({ success: true, items: salesItems, count });
    }

    if (action === 'delete') {
      const current = await getSalesItem();
      await verifyQuotationOwnership(current.quotation_id);

      const { data, error } = await supabaseAdmin
        .from('quotation_items')
        .delete()
        .eq('id', id)
        .eq('quotation_id', current.quotation_id)
        .select('id')
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) throw new Error('Item not found');
      await recalculateTotals(current.quotation_id, site_id);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Quotation Items tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
