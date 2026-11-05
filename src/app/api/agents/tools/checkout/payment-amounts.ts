type PaymentOrder = {
  currency?: string | null;
  subtotal: unknown;
  tax_total?: unknown;
  shipping_cost?: unknown;
  discount_total?: unknown;
  total: unknown;
};

type PaymentItem = {
  name?: string;
  description?: string | null;
  unit_price?: unknown;
  unitPrice?: unknown;
  quantity?: unknown;
};

// Preserve this integration's two-decimal money convention (100 minor units).
// Reject unsupported precision rather than silently changing persisted amounts.
function cents(value: unknown, field: string): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new Error(`Invalid payment amount: ${field}`);
  }
  const amount = Number(value);
  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(rounded) ||
      Math.abs(scaled - rounded) > 1e-7) {
    throw new Error(`Invalid two-decimal payment amount: ${field}`);
  }
  return rounded;
}

/** Uses only persisted amounts; never derives tax from current catalog settings. */
export function buildPaymentAmounts(order: PaymentOrder, items: PaymentItem[]) {
  const currency = (order.currency || 'usd').toLowerCase();
  const subtotal = cents(order.subtotal, 'subtotal');
  const tax = cents(order.tax_total ?? 0, 'tax_total');
  const shipping = cents(order.shipping_cost ?? 0, 'shipping_cost');
  const discountCents = cents(order.discount_total ?? 0, 'discount_total');
  const totalCents = cents(order.total, 'total');
  if (!items.length) throw new Error('Order has no line items to charge');

  const makeLine = (name: string, amount: number, quantity = 1, description?: string) => ({
    price_data: {
      currency,
      product_data: { name, description },
      unit_amount: amount,
      // Amounts already include all persisted tax; Stripe must not add more.
      tax_behavior: 'inclusive' as const,
    },
    quantity,
  });
  let accumulated = 0;
  let allocatedCents = 0;
  let lineItems = items.map((item) => {
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Invalid payment item quantity');
    }
    const rawPrice = item.unit_price ?? item.unitPrice;
    if ((typeof rawPrice !== 'number' && typeof rawPrice !== 'string') || String(rawPrice).trim() === '') {
      throw new Error('Invalid payment unit price');
    }
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price < 0) throw new Error('Invalid payment unit price');
    accumulated += price * quantity;
    const nextCents = Math.round((accumulated + Number.EPSILON) * 100);
    if (!Number.isSafeInteger(nextCents)) throw new Error('Invalid payment line amount');
    // Allocate rounded cumulative cents so fractional lines sum to the rounded
    // order subtotal, rather than independently rounding away cents per item.
    const lineCents = nextCents - allocatedCents;
    allocatedCents = nextCents;
    const unitCents = Math.round(price * 100);
    if (Number.isSafeInteger(quantity) && Math.abs(price * 100 - unitCents) < 1e-7
      && unitCents * quantity === lineCents) {
      return makeLine(item.name || 'Item', unitCents, quantity, item.description || undefined);
    }
    return makeLine(item.name || 'Item', lineCents, 1,
      `Quantity: ${quantity}; unit price: ${price}. ${item.description || ''}`.trim());
  });
  const itemCents = lineItems.reduce((sum, item) => sum + item.price_data.unit_amount * item.quantity, 0);
  const gross = subtotal + tax + shipping;
  if (!Number.isSafeInteger(itemCents) || itemCents !== subtotal || !Number.isSafeInteger(gross) ||
      discountCents > gross || gross - discountCents !== totalCents) {
    throw new Error('Order payment amounts do not reconcile');
  }
  if (tax > 0) lineItems.push(makeLine('Tax', tax));
  if (shipping > 0) lineItems.push(makeLine('Shipping', shipping));
  if (lineItems.length > 100) {
    // Stripe payment-mode sessions allow at most 100 lines. Keep tax/shipping
    // explicit, consolidate merchandise only; persisted order details remain intact.
    lineItems = [makeLine('Order items', subtotal, 1, `${items.length} product/modifier lines; see order for details`),
      ...(tax > 0 ? [makeLine('Tax', tax)] : []),
      ...(shipping > 0 ? [makeLine('Shipping', shipping)] : [])];
  }
  return { lineItems, discountCents, totalCents, currency };
}
