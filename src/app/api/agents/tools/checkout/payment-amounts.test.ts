import assert from 'node:assert/strict';
import { buildPaymentAmounts } from './payment-amounts';

const base = { subtotal: 100, tax_total: 16, discount_total: 0, shipping_cost: 0, total: 116, currency: 'MXN' };
const items = [{ name: 'Product', unit_price: 100, quantity: 1 }];

for (const [name, overrides, expected] of [
  ['base 100 plus tax 16', {}, 11600],
  ['persisted discount 10', { discount_total: 10, total: 106 }, 10600],
  ['shipping and discount', { shipping_cost: 5.25, discount_total: 10, total: 111.25 }, 11125],
  ['legacy zero tax', { tax_total: 0, total: 100 }, 10000],
  ['legacy absent tax and shipping', { tax_total: undefined, shipping_cost: undefined, total: 100 }, 10000],
] as const) {
  test(name, () => {
    const order = { ...base, ...overrides };
    const before = { ...order };
    const result = buildPaymentAmounts(order, items);
    const charge = result.lineItems.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0)
      - result.discountCents;
    assert.equal(charge, expected);
    assert.equal(charge, result.totalCents);
    assert.equal(result.currency, 'mxn');
    assert.equal(result.discountCents, order.discount_total * 100);
    assert.deepEqual(order, before);
    assert.deepEqual(result.lineItems.map(line => line.price_data.product_data.name), [
      'Product', ...(order.tax_total ? ['Tax'] : []), ...(order.shipping_cost ? ['Shipping'] : []),
    ]);
  });
}

test('relational modifier lines and legacy camelCase prices reconcile', () => {
  for (const lines of [
    [{ unit_price: 40, quantity: 2 }, { unit_price: 10, quantity: 2 }],
    [{ unitPrice: '40', quantity: 2 }, { unitPrice: '10', quantity: 2 }],
  ]) assert.equal(buildPaymentAmounts(base, lines).totalCents, 11600);
});

test('two decimal values and floating-point representation are supported', () => {
  const result = buildPaymentAmounts({ subtotal: '0.30', total: 0.1 + 0.2 }, [{ unit_price: '0.10', quantity: 3 }]);
  assert.equal(result.totalCents, 30);
});

for (const [name, order, lines] of [
  ['total mismatch', { ...base, total: 100 }, items],
  ['item mismatch even when order totals reconcile', base, [{ unit_price: 99, quantity: 1 }]],
  ['subtotal mismatch', { ...base, subtotal: 99 }, items],
  ['discount exceeds gross (no coupon clamping)', { ...base, discount_total: 117, total: 0 }, items],
  ['missing lines', base, []],
  ['zero quantity', base, [{ unit_price: 100, quantity: 0 }]],
  ['invalid money', { ...base, tax_total: NaN }, items],
  ['negative shipping', { ...base, shipping_cost: -1 }, items],
  ['missing total', { ...base, total: undefined }, items],
  ['unsupported precision', { subtotal: 1.001, total: 1.001 }, [{ unit_price: 1.001 }]],
] as const) {
  test(`refuses ${name}`, () => {
    assert.throws(() => buildPaymentAmounts(order, [...lines]));
  });
}

test.each([
  { subtotal: 50, tax: 8, price: 100, quantity: 0.5 },
  { subtotal: 0.03, tax: 0.01, price: 0.034, quantity: 1 },
])('charges fractional/precise lines using their line amount: %j', ({ subtotal, tax, price, quantity }) => {
  const result = buildPaymentAmounts({ subtotal, tax_total: tax, total: subtotal + tax }, [{ unit_price: price, quantity }]);
  expect(result.lineItems[0].quantity).toBe(1);
  expect(result.lineItems[0].price_data.unit_amount).toBe(Math.round(subtotal * 100));
  expect(result.lineItems.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0)).toBe(result.totalCents);
});

test('fractional cent allocation reconciles cumulative rather than individual rounding', () => {
  const result = buildPaymentAmounts({ subtotal: 0.01, total: 0.01 }, Array.from({ length: 3 }, () => ({ unit_price: 0.004, quantity: 1 })));
  expect(result.lineItems.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0)).toBe(1);
});

test.each([99, 100, 101, 595])('stays within Stripe limit with %s merchandise lines plus tax/shipping', count => {
  const result = buildPaymentAmounts({ subtotal: count, tax_total: 16, shipping_cost: 5, discount_total: 10, total: count + 11 },
    Array.from({ length: count }, () => ({ unit_price: 1, quantity: 1 })));
  expect(result.lineItems.length).toBeLessThanOrEqual(100);
  expect(result.lineItems.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0) - result.discountCents).toBe(result.totalCents);
});
