import { createSaleOrderFromLines } from '../create-order';
import { findExistingCreatedOrder } from '../order-idempotency';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock('../order-idempotency', () => ({
  findExistingCreatedOrder: jest.fn(),
}));

jest.mock('../process-lines', () => ({
  processCheckoutLines: jest.fn(),
  buildOrderItemsJson: jest.fn(),
  insertOrderItemsWithModifiers: jest.fn(),
}));

jest.mock('@/lib/promotions/apply', () => ({
  calculateAutoDiscount: jest.fn(),
  formatAppliedPromotionsNotification: jest.fn(),
}));

describe('createSaleOrderFromLines idempotency', () => {
  it('returns the existing sale instead of inserting a duplicate', async () => {
    const existing = {
      sale: { id: 'sale-1' },
      order: { id: 'order-1', status: 'pending' },
      lead_id: 'lead-1',
      reservations: [{ id: 'res-1' }],
      subtotal: 10,
      discount_total: 0,
      total: 10,
      applied_promotions: [],
    };
    (findExistingCreatedOrder as jest.Mock).mockResolvedValue(existing);

    const result = await createSaleOrderFromLines({
      site_id: 'site-1',
      lead_id: 'lead-1',
      lines: [{ catalogItemId: 'item-1', quantity: 1 }],
      command_id: 'cmd-1',
      idempotency_key: 'cmd-1:checkout:create_order:abc',
    });

    expect(result).toBe(existing);
    const { processCheckoutLines } = await import('../process-lines');
    expect(processCheckoutLines).not.toHaveBeenCalled();
  });
});
