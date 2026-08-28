import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  calculateAutoDiscount,
  formatAppliedPromotionsNotification,
  type AppliedPromotion,
  type DiscountLineItem,
} from '@/lib/promotions/apply';
import {
  buildOrderItemsJson,
  insertOrderItemsWithModifiers,
  processCheckoutLines,
  type CheckoutLine,
} from './process-lines';
import { findExistingCreatedOrder } from './order-idempotency';
import { IDEMPOTENCY_KEY_FIELD, isUuid } from '@/lib/agentbase/utils/write-idempotency';

export type ReservationExtras = {
  entitlement_id?: string | null;
  status?: string;
  notes?: string | null;
};

export type CreateSaleOrderFromLinesParams = {
  site_id: string;
  lines: CheckoutLine[];
  lead_id: string | null;
  buyer_user_id?: string | null;
  owner_site_id?: string | null;
  source?: string;
  location_id?: string | null;
  order_notes?: string | null;
  user_id?: string;
  reservationExtras?: ReservationExtras;
  command_id?: string | null;
  idempotency_key?: string | null;
};

export type CreatedSaleOrder = {
  sale: Record<string, any>;
  order: Record<string, any>;
  lead_id: string | null;
  reservations: Record<string, any>[];
  subtotal: number;
  discount_total: number;
  total: number;
  applied_promotions: AppliedPromotion[];
  notification?: string;
};

export function discountFieldsForToolResult(result: CreatedSaleOrder) {
  return {
    subtotal: result.subtotal,
    discount_total: result.discount_total,
    total: result.total,
    applied_promotions: result.applied_promotions,
    ...(result.notification ? { notification: result.notification } : {}),
  };
}

export async function resolveSiteUserId(siteId: string): Promise<string> {
  const { data: site, error } = await supabaseAdmin
    .from('sites')
    .select('user_id')
    .eq('id', siteId)
    .single();

  if (error || !site?.user_id) {
    throw new Error(`Unable to resolve site owner for site_id=${siteId}`);
  }
  return site.user_id;
}

export async function createSaleOrderFromLines(
  params: CreateSaleOrderFromLinesParams
): Promise<CreatedSaleOrder> {
  const {
    site_id,
    lines,
    lead_id,
    buyer_user_id,
    owner_site_id,
    source = 'online',
    location_id,
    order_notes,
    user_id,
    reservationExtras,
    command_id,
    idempotency_key,
  } = params;

  if (idempotency_key) {
    const existing = await findExistingCreatedOrder(idempotency_key);
    if (existing) {
      console.log(`[checkout] Replaying existing sale ${existing.sale.id} for key ${idempotency_key}`);
      return existing;
    }
  }

  const resolvedUserId = user_id || (await resolveSiteUserId(site_id));
  const { processedLines, subtotal } = await processCheckoutLines({
    siteId: site_id,
    lines,
    finalLeadId: lead_id,
  });

  const saleDate = new Date().toISOString().split('T')[0];
  const primaryCurrency = processedLines[0]?.currency || 'USD';

  const discountLines: DiscountLineItem[] = [];
  for (const pl of processedLines) {
    discountLines.push({
      id: pl.catalog_item_id,
      quantity: pl.quantity,
      subtotal: pl.subtotal,
    });
    for (const mod of pl.modifiers) {
      discountLines.push({
        id: mod.catalog_item_id,
        quantity: mod.quantity,
        subtotal: mod.subtotal,
      });
    }
  }

  const { discountAmount, appliedPromotions } = await calculateAutoDiscount(site_id, discountLines);
  const amount_due = Math.max(0, subtotal - discountAmount);

  const { data: sale, error: saleErr } = await supabaseAdmin
    .from('sales')
    .insert({
      site_id,
      lead_id,
      buyer_user_id: buyer_user_id || null,
      owner_site_id: owner_site_id || null,
      title: `Order - ${saleDate}`,
      status: 'pending',
      amount: subtotal,
      amount_due: amount_due,
      currency: primaryCurrency,
      user_id: resolvedUserId,
      sale_date: saleDate,
      source,
      location_id: location_id || null,
      notes: order_notes || null,
      ...(isUuid(command_id) ? { command_id } : {}),
      ...(idempotency_key
        ? { product_details: { [IDEMPOTENCY_KEY_FIELD]: idempotency_key } }
        : {}),
    })
    .select()
    .single();
  if (saleErr) throw new Error(`Sale creation failed: ${saleErr.message}`);

  const orderItemsJson = buildOrderItemsJson(processedLines);

  const { data: order, error: orderErr } = await supabaseAdmin
    .from('sale_orders')
    .insert({
      sale_id: sale.id,
      site_id,
      buyer_user_id: buyer_user_id || null,
      owner_site_id: owner_site_id || null,
      status: 'pending',
      order_number: `ORD-${Date.now().toString().slice(-6)}`,
      user_id: resolvedUserId,
      total: amount_due,
      subtotal,
      discount_total: discountAmount,
      currency: primaryCurrency,
      notes: order_notes || null,
      items: orderItemsJson,
    })
    .select()
    .single();
  if (orderErr) throw new Error(`Order creation failed: ${orderErr.message}`);

  const insertedHosts = await insertOrderItemsWithModifiers(order.id, processedLines);

  const reservationsToInsert = processedLines
    .map((pl, idx) => {
      if (!pl.reservationStart || !pl.reservationEnd) return null;
      const insertedItem = insertedHosts[idx];
      return {
        site_id: pl.site_id,
        catalog_item_id: pl.catalog_item_id,
        lead_id,
        buyer_user_id: buyer_user_id || null,
        owner_site_id: owner_site_id || null,
        sale_order_item_id: insertedItem?.id,
        start_time: pl.reservationStart,
        end_time: pl.reservationEnd,
        quantity: pl.quantity,
        status: reservationExtras?.status || 'pending',
        entitlement_id: reservationExtras?.entitlement_id || null,
        notes: reservationExtras?.notes || null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  let reservations: Record<string, any>[] = [];
  if (reservationsToInsert.length > 0) {
    const { data: createdReservations, error: resErr } = await supabaseAdmin
      .from('reservations')
      .insert(reservationsToInsert)
      .select();
    if (resErr) {
      throw new Error(`Failed to create capacity reservations for order: ${resErr.message}`);
    }
    reservations = createdReservations || [];
  }

  const notification = formatAppliedPromotionsNotification(
    appliedPromotions,
    subtotal,
    discountAmount,
    amount_due,
    primaryCurrency
  );

  return {
    sale,
    order,
    lead_id,
    reservations,
    subtotal,
    discount_total: discountAmount,
    total: amount_due,
    applied_promotions: appliedPromotions,
    notification,
  };
}
