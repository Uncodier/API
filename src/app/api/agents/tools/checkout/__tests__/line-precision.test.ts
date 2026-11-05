import { processCheckoutLines } from '../process-lines';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../resolve-currency', () => ({ resolveSiteCurrency: async () => 'MXN', resolveLineCurrency: () => 'MXN' }));

test('line processing preserves taxable precision for host and modifier, rounds only aggregate subtotal', async () => {
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const q: any = {};
    for (const method of ['select', 'eq']) q[method] = () => q;
    q.single = async () => ({ data: { id: 'item', name: 'Item', site_id: 'site',
      target_sale_price: 0.034, status: 'active', availability_status: 'available' }, error: null });
    q.then = (resolve: any) => resolve({ data: table === 'catalog_item_modifier_groups' ? [] : null, error: null });
    return q;
  });
  const result = await processCheckoutLines({ siteId: 'site', finalLeadId: null,
    lines: [{ catalogItemId: 'item', quantity: 1, modifiers: [{ catalogItemId: 'extra', quantity: 0.5 }] }],
  });
  expect(result.processedLines[0].subtotal).toBe(0.034);
  expect(result.processedLines[0].modifiers[0].subtotal).toBe(0.017);
  expect(result.subtotal).toBe(0.05);
});