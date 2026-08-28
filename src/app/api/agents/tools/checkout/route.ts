import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createSaleOrderFromLines, discountFieldsForToolResult, resolveSiteUserId } from './create-order';
import { type CheckoutLine } from './process-lines';
import { buildWriteIdempotencyKey } from '@/lib/agentbase/utils/write-idempotency';

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
    const { action, order_id, site_id, command_id, ...params } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'create_order_from_quotation') {
      const { quotation_id } = params as { quotation_id: string };
      if (!site_id) throw new Error('site_id is required');

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

      params.lines = linesToPass;
      params.lead_id = quote.lead_id;
      params.buyer_user_id = quote.buyer_user_id || undefined;
      params.source = 'online';
      body.action = 'create_order';
    }

    if (body.action === 'create_order') {
      const {
        lines,
        buyer_user_id,
        customer_email,
        owner_site_id,
        source = 'online',
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

      const siteOwnerId = await resolveSiteUserId(site_id);
      const finalLeadId = await resolveLeadId({
        siteId: site_id,
        userId: siteOwnerId,
        leadId: lead_id,
        customerEmail: customer_email,
        buyerUserId: buyer_user_id,
      });

      const orderNotes =
        action === 'create_order_from_quotation'
          ? `Created from quotation ${params.quotation_id}`
          : null;

      const writeAction = action === 'create_order_from_quotation' ? 'create_order_from_quotation' : 'create_order';
      const idempotency_key = command_id
        ? buildWriteIdempotencyKey(String(command_id), 'checkout', writeAction, {
            site_id,
            lines,
            lead_id: finalLeadId,
            quotation_id: params.quotation_id,
            buyer_user_id,
            owner_site_id,
            source,
            location_id,
          })
        : null;

      const result = await createSaleOrderFromLines({
        site_id,
        lines,
        lead_id: finalLeadId,
        buyer_user_id,
        owner_site_id,
        source,
        location_id,
        order_notes: orderNotes,
        user_id: siteOwnerId,
        command_id: command_id || null,
        idempotency_key,
      });

      return NextResponse.json({
        success: true,
        order_id: result.order.id,
        sale_id: result.sale.id,
        lead_id: result.lead_id,
        status: result.order.status,
        customer_email: customer_email || null,
        ...discountFieldsForToolResult(result),
      });
    }

    if (action === 'create_payment_link') {
      const { findExistingPaymentLink, storePaymentLinkIdempotency } = await import('./order-idempotency');
      const paymentKey = command_id
        ? buildWriteIdempotencyKey(String(command_id), 'checkout', 'create_payment_link', {
            order_id,
            site_id,
            return_url: params.return_url,
          })
        : null;
      if (paymentKey) {
        const existingLink = await findExistingPaymentLink(paymentKey);
        if (existingLink) {
          return NextResponse.json({ success: true, url: existingLink.url, order_id: existingLink.order_id });
        }
      }

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
      const { data: sale } = await supabaseAdmin
        .from('sales')
        .select('lead_id, payment_details')
        .eq('id', order.sale_id)
        .single();

      if (!customerEmail && sale?.lead_id) {
        const { data: lead } = await supabaseAdmin
          .from('leads')
          .select('email')
          .eq('id', sale.lead_id)
          .single();
        customerEmail = lead?.email || undefined;
      }

      const existingPaymentDetails = (sale?.payment_details && typeof sale.payment_details === 'object') 
        ? (sale.payment_details as Record<string, unknown>) 
        : {};

      // Prefer relational sale_order_items (includes modifier children as separate priced lines).
      let lineSource: any[] = Array.isArray(order.items) ? order.items : [];
      const looksRelational = lineSource.length > 0 && 'unit_price' in (lineSource[0] || {});
      if (!looksRelational) {
        const { data: rawOrder } = await supabaseAdmin
          .from('sale_orders')
          .select('items')
          .eq('id', order_id)
          .single();
        if (Array.isArray(rawOrder?.items) && rawOrder.items.length > 0) {
          // Flatten JSONB nested modifiers into separate Stripe lines
          lineSource = [];
          for (const item of rawOrder.items) {
            lineSource.push(item);
            for (const mod of item.modifiers || []) {
              lineSource.push(mod);
            }
          }
        }
      }

      if (!lineSource.length) {
        throw new Error('Order has no line items to charge');
      }

      const lineItems = lineSource.map((item: any) => ({
        price_data: {
          currency: (order.currency || 'usd').toLowerCase(),
          product_data: {
            name: item.name || 'Item',
            description: item.description || undefined,
          },
          unit_amount: Math.round(Number(item.unit_price ?? item.unitPrice ?? 0) * 100),
        },
        quantity: Number(item.quantity || 1),
      }));

      const sessionPayload: Record<string, unknown> = {
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
      };

      const discountTotal = Number(order.discount_total || 0);
      const discountCents = Math.round(discountTotal * 100);
      const lineCents = lineItems.reduce(
        (sum: number, item: { price_data: { unit_amount: number }; quantity: number }) =>
          sum + item.price_data.unit_amount * item.quantity,
        0
      );
      if (discountCents > 0 && lineCents > 0) {
        const coupon = await stripe.coupons.create({
          amount_off: Math.min(discountCents, lineCents),
          currency: (order.currency || 'usd').toLowerCase(),
          duration: 'once',
          name: 'Compatible promotion',
        });
        sessionPayload.discounts = [{ coupon: coupon.id }];
      }

      const session = await stripe.checkout.sessions.create(sessionPayload as any);

      if (paymentKey && session.url) {
        await storePaymentLinkIdempotency({
          saleId: order.sale_id,
          key: paymentKey,
          url: session.url,
          orderId: order_id,
          existingDetails: existingPaymentDetails,
        });
      }

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
