import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  buildOrderItemsJson,
  insertOrderItemsWithModifiers,
  processCheckoutLines,
  type CheckoutLine,
} from './process-lines';

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
};

export type CreatedSaleOrder = {
  sale: Record<string, any>;
  order: Record<string, any>;
  lead_id: string | null;
  reservations: Record<string, any>[];
};

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
  } = params;

  const resolvedUserId = user_id || (await resolveSiteUserId(site_id));
  const { processedLines, subtotal } = await processCheckoutLines({
    siteId: site_id,
    lines,
    finalLeadId: lead_id,
  });

  const saleDate = new Date().toISOString().split('T')[0];
  const primaryCurrency = processedLines[0]?.currency || 'USD';

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
      amount_due: subtotal,
      currency: primaryCurrency,
      user_id: resolvedUserId,
      sale_date: saleDate,
      source,
      location_id: location_id || null,
      notes: order_notes || null,
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
      total: subtotal,
      subtotal,
      discount_total: 0,
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

  return { sale, order, lead_id, reservations };
}
