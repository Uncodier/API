import { supabaseAdmin } from '@/lib/database/supabase-client';
import { IDEMPOTENCY_KEY_FIELD } from '@/lib/agentbase/utils/write-idempotency';
import type { CreatedSaleOrder } from './create-order';

export async function findSaleByIdempotencyKey(key: string): Promise<Record<string, any> | null> {
  const { data, error } = await supabaseAdmin
    .from('sales')
    .select('*')
    .contains('product_details', { [IDEMPOTENCY_KEY_FIELD]: key })
    .maybeSingle();
  if (error) {
    console.warn('[write-idempotency] sale lookup failed:', error.message);
    return null;
  }
  return data || null;
}

export async function loadCreatedOrderFromSale(sale: Record<string, any>): Promise<CreatedSaleOrder | null> {
  const { data: order, error: orderErr } = await supabaseAdmin
    .from('sale_orders')
    .select('*')
    .eq('sale_id', sale.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (orderErr || !order) return null;

  const { data: items } = await supabaseAdmin
    .from('sale_order_items')
    .select('id')
    .eq('sale_order_id', order.id);
  const itemIds = (items || []).map((item: { id: string }) => item.id);

  let reservations: Record<string, any>[] = [];
  if (itemIds.length > 0) {
    const { data: reservationRows } = await supabaseAdmin
      .from('reservations')
      .select('*')
      .in('sale_order_item_id', itemIds);
    reservations = reservationRows || [];
  }

  return {
    sale,
    order,
    lead_id: sale.lead_id || null,
    reservations,
    subtotal: Number(order.subtotal || sale.amount || 0),
    discount_total: Number(order.discount_total || 0),
    total: Number(order.total || sale.amount_due || 0),
    applied_promotions: [],
  };
}

export async function findExistingCreatedOrder(key: string): Promise<CreatedSaleOrder | null> {
  const sale = await findSaleByIdempotencyKey(key);
  if (!sale) return null;
  return loadCreatedOrderFromSale(sale);
}

export async function findExistingPaymentLink(key: string): Promise<{ url: string; order_id: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('sales')
    .select('payment_details')
    .contains('payment_details', { [key]: {} })
    .maybeSingle();
  if (error) {
    console.warn('[write-idempotency] payment link lookup failed:', error.message);
    return null;
  }
  
  // Backwards compatibility with flat structure
  let details = data?.payment_details as any;
  if (details?.[IDEMPOTENCY_KEY_FIELD] === key) {
    if (details?.checkout_url && details?.checkout_order_id) {
      return { url: details.checkout_url, order_id: details.checkout_order_id };
    }
  }

  // Nested structure
  const nestedDetails = details?.[key] as { checkout_url?: string; checkout_order_id?: string } | undefined;
  if (nestedDetails?.checkout_url && nestedDetails?.checkout_order_id) {
    return { url: nestedDetails.checkout_url, order_id: nestedDetails.checkout_order_id };
  }
  return null;
}

export async function storePaymentLinkIdempotency(params: {
  saleId: string;
  key: string;
  url: string;
  orderId: string;
  existingDetails?: Record<string, unknown> | null;
}): Promise<void> {
  let current = params.existingDetails || {};
  if (!params.existingDetails) {
    const { data } = await supabaseAdmin
      .from('sales')
      .select('payment_details')
      .eq('id', params.saleId)
      .maybeSingle();
    if (data?.payment_details && typeof data.payment_details === 'object') {
      current = data.payment_details as Record<string, unknown>;
    }
  }
  const nextDetails = {
    ...current,
    [params.key]: {
      checkout_url: params.url,
      checkout_order_id: params.orderId,
    }
  };
  const { error } = await supabaseAdmin
    .from('sales')
    .update({ payment_details: nextDetails })
    .eq('id', params.saleId);
  if (error) {
    console.warn('[write-idempotency] payment_details update failed:', error.message);
  }
}
