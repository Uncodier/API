import { calculateCheckoutTaxTotal } from '../taxes';
import { createSaleOrderFromLines, discountFieldsForToolResult } from '../create-order';
import { loadCreatedOrderFromSale } from '../order-idempotency';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { processCheckoutLines, insertOrderItemsWithModifiers } from '../process-lines';
import { calculateAutoDiscount } from '@/lib/promotions/apply';
import { buildPaymentAmounts } from '../payment-amounts';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../process-lines', () => ({ processCheckoutLines: jest.fn(), buildOrderItemsJson: jest.fn(() => []), insertOrderItemsWithModifiers: jest.fn() }));
jest.mock('@/lib/promotions/apply', () => ({ calculateAutoDiscount: jest.fn(), formatAppliedPromotionsNotification: jest.fn() }));

let taxes: any[];
let readError: boolean;
let savedOrder: Record<string, unknown>;
let writes: { table: string; payload: any }[];
const taxRow = (item: string, rate: number, active = true) => ({
  id: `tax-${item}-${rate}`, catalog_item_id: item, tax: { id: 'tax', site_id: 'site', rate, is_active: active },
});
beforeEach(() => {
  jest.clearAllMocks(); taxes = [taxRow('item', 16)]; readError = false; writes = [];
  savedOrder = { id: 'order', subtotal: 100, tax_total: 16, total: 116, discount_total: 0 };
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    let from = 0, to = 99;
    let itemIds: string[] = [];
    const chain: any = {};
    for (const method of ['select', 'eq', 'in', 'order', 'range', 'limit', 'single', 'maybeSingle']) {
      chain[method] = (...args: any[]) => {
        if (method === 'range') [from, to] = args;
        if (method === 'in' && args[0] === 'catalog_item_id') itemIds = args[1];
        return chain;
      };
    }
    chain.insert = (payload: any) => { writes.push({ table, payload }); return chain; };
    chain.then = (resolve: any) => resolve({
      data: table === 'catalog_item_taxes' ? taxes.filter(row => itemIds.includes(row.catalog_item_id)).slice(from, to + 1)
        : table === 'sales' ? { id: 'sale' } : table === 'sale_orders' ? savedOrder : [],
      error: readError && table === 'catalog_item_taxes' ? { message: 'unavailable' } : null,
    });
    return chain;
  });
  (calculateAutoDiscount as jest.Mock).mockResolvedValue({ discountAmount: 0, appliedPromotions: [] });
  (processCheckoutLines as jest.Mock).mockResolvedValue({ subtotal: 100, processedLines: [{
    catalog_item_id: 'item', site_id: 'site', name: 'Item', quantity: 1, unit_price: 100,
    subtotal: 100, currency: 'MXN', modifiers: [],
  }] });
  (insertOrderItemsWithModifiers as jest.Mock).mockResolvedValue([{ id: 'line' }]);
});

test('adds active rates, excludes inactive taxes and rounds per line', async () => {
  taxes = [taxRow('item', 16), taxRow('item', 8), taxRow('item', 50, false)];
  expect(await calculateCheckoutTaxTotal('site', [{ catalog_item_id: 'item', subtotal: 100 }])).toBe(24);
  expect(await calculateCheckoutTaxTotal('site', [{ catalog_item_id: 'none', subtotal: 100 }])).toBe(0);
  taxes = [taxRow('item', 16)];
  expect(await calculateCheckoutTaxTotal('site', Array.from({ length: 3 }, () => ({ catalog_item_id: 'item', subtotal: 0.03 })))).toBe(0);
});

test('does not truncate more than 100 associations', async () => {
  taxes = Array.from({ length: 205 }, (_, i) => taxRow(`item-${i}`, 16));
  expect(await calculateCheckoutTaxTotal('site', taxes.map(row => ({ catalog_item_id: row.catalog_item_id, subtotal: 100 })))).toBe(3280);
});

test.each([NaN, -1, 101, null])('rejects invalid rate %s', async rate => {
  taxes[0].tax.rate = rate;
  await expect(calculateCheckoutTaxTotal('site', [{ catalog_item_id: 'item', subtotal: 100 }])).rejects.toThrow('tax rate');
});

test('refuses foreign tax ownership', async () => {
  taxes[0].tax.site_id = 'other';
  await expect(calculateCheckoutTaxTotal('site', [{ catalog_item_id: 'item', subtotal: 100 }])).rejects.toThrow('association');
});

test.each([0, 10])('sale, order, tool and payment totals agree with discount %s', async discount => {
  (calculateAutoDiscount as jest.Mock).mockResolvedValue({ discountAmount: discount, appliedPromotions: [] });
  const result = await createSaleOrderFromLines({ site_id: 'site', user_id: 'user', lead_id: null, lines: [] });
  expect(discountFieldsForToolResult(result)).toMatchObject({ subtotal: 100, tax_total: 16, discount_total: discount, total: 116 - discount });
  expect(writes.find(w => w.table === 'sales')?.payload).toMatchObject({ amount: 116 - discount, amount_due: 116 - discount });
  const order = writes.find(w => w.table === 'sale_orders')!.payload;
  expect(order).toMatchObject({ subtotal: 100, tax_total: 16, total: 116 - discount });
  expect(buildPaymentAmounts(order, [{ name: 'Item', unit_price: 100, quantity: 1 }]).totalCents).toBe((116 - discount) * 100);
});

test('taxes modifiers independently and includes them in persisted total', async () => {
  taxes.push(taxRow('modifier', 8));
  const lines = await (processCheckoutLines as jest.Mock)();
  lines.processedLines[0].modifiers = [{ catalog_item_id: 'modifier', subtotal: 50, quantity: 1, currency: 'MXN' }];
  lines.subtotal = 150;
  const result = await createSaleOrderFromLines({ site_id: 'site', user_id: 'user', lead_id: null, lines: [] });
  expect(result).toMatchObject({ subtotal: 150, tax_total: 20, total: 170 });
});

test('tax lookup failure stops before any sale or order write', async () => {
  readError = true;
  await expect(createSaleOrderFromLines({ site_id: 'site', user_id: 'user', lead_id: null, lines: [] })).rejects.toThrow('verify checkout taxes');
  expect(writes).toEqual([]);
});

test('precise taxable subtotal survives order creation and Stripe reconciliation', async () => {
  const processed = await (processCheckoutLines as jest.Mock)();
  processed.subtotal = 0.03;
  Object.assign(processed.processedLines[0], { unit_price: 0.034, subtotal: 0.034 });
  const result = await createSaleOrderFromLines({ site_id: 'site', user_id: 'user', lead_id: null, lines: [] });
  expect(result).toMatchObject({ subtotal: 0.03, tax_total: 0.01, total: 0.04 });
  const order = writes.find(write => write.table === 'sale_orders')!.payload;
  expect(buildPaymentAmounts(order, [{ unit_price: 0.034, quantity: 1 }]).totalCents).toBe(4);
});

test('mixed currencies fail rather than summing unrelated taxable amounts', async () => {
  const lines = await (processCheckoutLines as jest.Mock)();
  lines.processedLines[0].modifiers = [{ catalog_item_id: 'modifier', subtotal: 50, currency: 'USD' }];
  await expect(createSaleOrderFromLines({ site_id: 'site', user_id: 'user', lead_id: null, lines: [] })).rejects.toThrow('Mixed-currency');
  expect(writes).toEqual([]);
});

test('replay uses stored tax, preserves zero totals and never loads current tax settings', async () => {
  savedOrder = { ...savedOrder, total: 0 };
  const result = await loadCreatedOrderFromSale({ id: 'sale', amount_due: 116 });
  expect(result).toMatchObject({ tax_total: 16, total: 0 });
  expect(supabaseAdmin.from).not.toHaveBeenCalledWith('catalog_item_taxes');
});