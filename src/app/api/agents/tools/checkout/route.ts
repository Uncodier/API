import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertReservationSlot } from '@/lib/reservations/availability';

type CheckoutLine = {
  catalogItemId: string;
  quantity?: number;
  unitPriceOverride?: number;
  reservationStart?: string; // ISO
  reservationEnd?: string;   // ISO
};

async function resolveSiteUserId(siteId: string): Promise<string> {
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

/** Find or create a lead so Stripe can receive customer_email via lead.email */
async function resolveLeadId(params: {
  siteId: string;
  userId: string;
  leadId?: string;
  customerEmail?: string;
  buyerUserId?: string;
}): Promise<string | null> {
  const { siteId, userId, leadId, customerEmail, buyerUserId } = params;
  if (leadId) return leadId;
  if (!customerEmail) return null;

  const { data: existing } = await supabaseAdmin
    .from('leads')
    .select('id, buyer_user_id')
    .eq('site_id', siteId)
    .eq('email', customerEmail)
    .maybeSingle();

  if (existing) {
    if (buyerUserId && !existing.buyer_user_id) {
      await supabaseAdmin
        .from('leads')
        .update({ buyer_user_id: buyerUserId })
        .eq('id', existing.id);
    }
    return existing.id;
  }

  const { data: created, error } = await supabaseAdmin
    .from('leads')
    .insert({
      site_id: siteId,
      name: customerEmail.split('@')[0] || customerEmail,
      email: customerEmail,
      status: 'new',
      user_id: userId,
      buyer_user_id: buyerUserId || null,
    })
    .select('id')
    .single();

  if (error) {
    console.warn('[checkout] lead create failed:', error.message);
    return null;
  }
  return created.id;
}

function commerceAppBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_COMMERCE_APP_URL ||
    process.env.NEXT_PUBLIC_FRONTEND_URL ||
    'https://app.makinari.com'
  ).replace(/\/$/, '');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, order_id, site_id, ...params } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'create_order_from_quotation') {
      const { quotation_id } = params as { quotation_id: string };
      if (!site_id) throw new Error('site_id is required');

      // 1. Fetch quotation
      const { data: quote, error: quoteErr } = await supabaseAdmin
        .from('quotations')
        .select('*, items:quotation_items(*)')
        .eq('id', quotation_id)
        .eq('site_id', site_id)
        .single();
        
      if (quoteErr || !quote) throw new Error('Quotation not found');
      if (quote.status === 'draft' || quote.status === 'rejected' || quote.status === 'expired') {
        throw new Error(`Cannot convert quotation with status: ${quote.status}`);
      }

      const linesToPass: CheckoutLine[] = (quote.items || []).map((qi: any) => ({
        catalogItemId: qi.catalog_item_id,
        quantity: qi.quantity,
        unitPriceOverride: qi.unit_price,
      }));

      // Map back to internal create_order flow
      body.action = 'create_order';
      params.lines = linesToPass;
      params.lead_id = quote.lead_id;
      params.buyer_user_id = quote.buyer_user_id || undefined;
      params.source = 'online'; // "quote" not reliably in sales.source constraint

      // Fall through to create_order block
      body.action = 'create_order';
    }

    if (body.action === 'create_order') {
      const {
        lines,
        buyer_user_id,
        customer_email,
        owner_site_id,
        source = 'online', // Default to a known DB allowed value
        lead_id,
        location_id,
      } = params as {
        lines?: CheckoutLine[];
        buyer_user_id?: string;
        customer_email?: string;
        owner_site_id?: string | null;
        source?: string;
        lead_id?: string;
        location_id?: string;
      };

      if (!site_id) throw new Error('site_id is required for create_order');
      if (!Array.isArray(lines) || lines.length === 0) {
        throw new Error('lines must be a non-empty array');
      }

      const resolvedUserId = await resolveSiteUserId(site_id);
      const finalLeadId = await resolveLeadId({
        siteId: site_id,
        userId: resolvedUserId,
        leadId: lead_id,
        customerEmail: customer_email,
        buyerUserId: buyer_user_id,
      });

      let subtotal = 0;
      const processedLines: Array<{
        site_id: string;
        catalog_item_id: string;
        name: string;
        description?: string | null;
        quantity: number;
        unit_price: number;
        subtotal: number;
        reservationStart?: string;
        reservationEnd?: string;
      }> = [];

      for (const line of lines) {
        if (!line?.catalogItemId) throw new Error('Each line requires catalogItemId');
        const quantity = Number(line.quantity || 1);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new Error(`Invalid quantity for catalogItemId=${line.catalogItemId}`);
        }

        const { data: catItem, error: catErr } = await supabaseAdmin
          .from('catalog_items')
          .select('id, name, description, target_sale_price, site_id, is_reservation, currency')
          .eq('id', line.catalogItemId)
          .single();

        if (catErr || !catItem) {
          throw new Error(`Catalog item not found: ${line.catalogItemId}`);
        }
        if (catItem.site_id !== site_id) {
          throw new Error(`Catalog item ${line.catalogItemId} does not belong to site ${site_id}`);
        }

        if (catItem.is_reservation) {
          if (!line.reservationStart || !line.reservationEnd) {
            throw new Error(`Item ${line.catalogItemId} is a reservation. reservationStart and reservationEnd are required.`);
          }
          if (!finalLeadId) {
            throw new Error('lead_id or customer_email is required for reservable items');
          }
          // Validate slot availability (isAdmin = true to bypass past date checks if agent is orchestrating)
          await assertReservationSlot(site_id, line.catalogItemId, line.reservationStart, line.reservationEnd, quantity, true);
        }

        const unitPrice =
          line.unitPriceOverride !== undefined
            ? Number(line.unitPriceOverride)
            : Number(catItem.target_sale_price || 0);
        const lineSubtotal = unitPrice * quantity;
        subtotal += lineSubtotal;

        processedLines.push({
          site_id,
          catalog_item_id: line.catalogItemId,
          name: catItem.name,
          description: catItem.description,
          quantity,
          unit_price: unitPrice,
          subtotal: lineSubtotal,
          reservationStart: line.reservationStart,
          reservationEnd: line.reservationEnd,
          currency: catItem.currency || 'USD',
        });
      }

      const saleDate = new Date().toISOString().split('T')[0];
      const primaryCurrency = processedLines[0]?.currency || 'USD';
      const orderNotes = body.action === 'create_order_from_quotation' ? `Created from quotation ${params.quotation_id}` : null;
      
      const { data: sale, error: saleErr } = await supabaseAdmin
        .from('sales')
        .insert({
          site_id,
          lead_id: finalLeadId,
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
          notes: orderNotes,
        })
        .select()
        .single();
      if (saleErr) throw new Error(`Sale creation failed: ${saleErr.message}`);

      const orderItemsJson = processedLines.map((pl) => ({
        id: pl.catalog_item_id,
        name: pl.name,
        quantity: pl.quantity,
        unitPrice: pl.unit_price,
        subtotal: pl.subtotal,
      }));

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
          notes: orderNotes,
          items: orderItemsJson,
        })
        .select()
        .single();
      if (orderErr) throw new Error(`Order creation failed: ${orderErr.message}`);

      const orderItemsToInsert = processedLines.map((pl) => ({
        site_id: pl.site_id,
        catalog_item_id: pl.catalog_item_id,
        name: pl.name,
        description: pl.description,
        quantity: pl.quantity,
        unit_price: pl.unit_price,
        subtotal: pl.subtotal,
        sale_order_id: order.id,
      }));

      const { data: insertedItems, error: itemsErr } = await supabaseAdmin
        .from('sale_order_items')
        .insert(orderItemsToInsert)
        .select();
      if (itemsErr) throw new Error(`Order items creation failed: ${itemsErr.message}`);

      // Insert reservations if applicable
      const reservationsToInsert = processedLines
        .map((pl, idx) => {
          if (!pl.reservationStart || !pl.reservationEnd) return null;
          const insertedItem = insertedItems?.[idx];
          return {
            site_id: pl.site_id,
            catalog_item_id: pl.catalog_item_id,
            lead_id: finalLeadId,
            buyer_user_id: buyer_user_id || null,
            owner_site_id: owner_site_id || null,
            sale_order_item_id: insertedItem?.id,
            start_time: pl.reservationStart,
            end_time: pl.reservationEnd,
            quantity: pl.quantity,
            status: 'pending',
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (reservationsToInsert.length > 0) {
        const { error: resErr } = await supabaseAdmin
          .from('reservations')
          .insert(reservationsToInsert);
        if (resErr) {
          throw new Error(`Failed to create capacity reservations for order: ${resErr.message}`);
        }
      }

      return NextResponse.json({
        success: true,
        order_id: order.id,
        sale_id: sale.id,
        lead_id: finalLeadId,
        status: order.status,
        customer_email: customer_email || null,
      });
    }

    if (action === 'create_payment_link') {
      const returnUrl = params.return_url || `${commerceAppBaseUrl()}/buyer/orders`;

      if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('STRIPE_SECRET_KEY not set in API environment');
      }

      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: '2025-05-28.basil' as any,
      });

      const { data: order, error: orderError } = await supabaseAdmin
        .from('sale_orders')
        .select('*, items:sale_order_items(*)')
        .eq('id', order_id)
        .eq('site_id', site_id)
        .single();

      if (orderError || !order) throw new Error('Order not found');

      let customerEmail = params.customer_email as string | undefined;
      if (!customerEmail) {
        const { data: sale } = await supabaseAdmin
          .from('sales')
          .select('lead_id')
          .eq('id', order.sale_id)
          .single();
        if (sale?.lead_id) {
          const { data: lead } = await supabaseAdmin
            .from('leads')
            .select('email')
            .eq('id', sale.lead_id)
            .single();
          customerEmail = lead?.email || undefined;
        }
      }

      // Prefer relational sale_order_items; fall back to JSONB items column.
      let lineSource: any[] = Array.isArray(order.items) ? order.items : [];
      const looksRelational = lineSource.length > 0 && ('unit_price' in (lineSource[0] || {}));
      if (!looksRelational) {
        const { data: rawOrder } = await supabaseAdmin
          .from('sale_orders')
          .select('items')
          .eq('id', order_id)
          .single();
        if (Array.isArray(rawOrder?.items) && rawOrder.items.length > 0) {
          lineSource = rawOrder.items;
        }
      }

      if (!lineSource.length) {
        throw new Error('Order has no line items to charge');
      }

      const lineItems = lineSource.map((item: any) => ({
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.name || 'Item',
            description: item.description || undefined,
          },
          unit_amount: Math.round(Number(item.unit_price ?? item.unitPrice ?? 0) * 100),
        },
        quantity: Number(item.quantity || 1),
      }));

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: lineItems,
        mode: 'payment',
        success_url: `${returnUrl}?success=true&order_id=${order_id}`,
        cancel_url: `${returnUrl}?canceled=true`,
        customer_email: customerEmail || undefined,
        metadata: {
          type: 'sale_order',
          site_id: order.site_id,
          order_id: order_id,
          sale_id: order.sale_id,
        },
      });

      return NextResponse.json({ success: true, url: session.url, order_id });
    }

    if (action === 'get_order') {
      const { data, error } = await supabaseAdmin
        .from('sale_orders')
        .select('*, items:sale_order_items(*)')
        .eq('id', order_id)
        .eq('site_id', site_id)
        .single();

      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, order: data });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Checkout tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
