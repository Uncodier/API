import { randomUUID } from 'node:crypto';
import { handleItemAction } from '@/app/api/agents/tools/catalog_commerce/handlers/items';
import { withCatalogPricing } from '@/app/api/agents/tools/catalog_commerce/handlers/pricing';
import { calculateCheckoutTaxTotal } from '@/app/api/agents/tools/checkout/taxes';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { searchCatalog } from '@/lib/services/catalog-search/service';
import { summarizeFunctions } from '@/lib/agentbase/services/command/tool-loop-context';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/catalog-search/service', () => ({ searchCatalog: jest.fn() }));
jest.mock('@/lib/helpers/catalog-bookable', () => ({
  ...jest.requireActual('@/lib/helpers/catalog-bookable'), loadUnbookableParentIds: async () => [],
}));

const site = randomUUID(), id = randomUUID();
let item: any;
let taxes: any[];
let taxError: boolean;
beforeEach(() => {
  jest.clearAllMocks();
  item = { id, site_id: site, name: 'Product', target_sale_price: 100, currency: 'MXN', status: 'active', availability_status: 'available' };
  taxes = [{ id: randomUUID(), catalog_item_id: id, tax: { id: randomUUID(), name: 'IVA', rate: 16, is_active: true, site_id: site } }];
  taxError = false;
  (searchCatalog as jest.Mock).mockResolvedValue({ success: true, items: [item], count: 1, result_kind: 'related', search_id: 'search' });
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    let single = false;
    const q: any = {};
    for (const method of ['select', 'eq', 'in', 'order', 'range']) q[method] = jest.fn(() => q);
    q.single = () => { single = true; return q; };
    q.then = (resolve: any) => resolve({ data: table === 'catalog_item_taxes' ? taxes : single ? item : [item],
      count: 1, error: table === 'catalog_item_taxes' && taxError ? { message: 'unavailable' } : null });
    return q;
  });
});

test.each(['list', 'search', 'get'])('%s returns server-computed IVA without include_taxes and preserves it in agent context', async mode => {
  const response = await handleItemAction({ action: mode === 'get' ? 'get' : 'list', site_id: site,
    ...(mode === 'get' ? { id } : {}), ...(mode === 'search' ? { search: 'product' } : {}),
  });
  const result = await response.json();
  const priced = result.item || result.items[0];
  expect(priced.pricing).toMatchObject({ status: 'available', base_price: 100, base_price_includes_tax: false,
    unit_tax_amount: 16, unit_price_with_tax: 116, active_taxes: [{ name: 'IVA', rate: 16 }],
  });
  expect(priced.target_sale_price).toBe(100);
  const context = summarizeFunctions([{ name: 'catalog_commerce', result }]);
  expect(context).toContain('"unit_price_with_tax":116');
  if (mode === 'search') expect(result).toMatchObject({ result_kind: 'related', search_id: 'search' });
  expect(await calculateCheckoutTaxTotal(site, [{ catalog_item_id: id, subtotal: 100 }])).toBe(priced.pricing.unit_tax_amount);
});

test('inactive taxes are not quoted and zero-tax products keep their price', async () => {
  taxes[0].tax.is_active = false;
  expect((await withCatalogPricing(site, [item]))[0].pricing).toMatchObject({ active_taxes: [], unit_tax_amount: 0, unit_price_with_tax: 100 });
});

test.each([null, undefined, -1, 'invalid'])('missing/invalid base %s never becomes a free price', async price => {
  item.target_sale_price = price;
  expect((await withCatalogPricing(site, [item]))[0].pricing).toMatchObject({ status: 'unavailable', unit_tax_amount: null, unit_price_with_tax: null });
});

test('zero is a valid price', async () => {
  item.target_sale_price = 0;
  expect((await withCatalogPricing(site, [item]))[0].pricing).toMatchObject({ status: 'available', unit_price_with_tax: 0 });
});

test('four-decimal base uses unrounded taxable subtotal just like checkout', async () => {
  item.target_sale_price = 0.034;
  const pricing = (await withCatalogPricing(site, [item]))[0].pricing;
  expect(pricing).toMatchObject({ base_price: 0.034, unit_tax_amount: 0.01, unit_price_with_tax: 0.04 });
  expect(await calculateCheckoutTaxTotal(site, [{ catalog_item_id: id, subtotal: 0.034 }])).toBe(pricing.unit_tax_amount);
});

test('tax lookup failures do not yield a misleading tax-free quote', async () => {
  taxError = true;
  await expect(handleItemAction({ action: 'list', site_id: site })).rejects.toThrow('verify checkout taxes');
});

test('foreign tax references are rejected', async () => {
  taxes[0].tax.site_id = randomUUID();
  await expect(withCatalogPricing(site, [item])).rejects.toThrow('tax association');
});