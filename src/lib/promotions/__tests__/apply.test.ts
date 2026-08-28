import {
  evaluateCompatiblePromotions,
  formatAppliedPromotionsNotification,
  type DiscountLineItem,
  type PromotionCandidate,
} from '../apply';

const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAT_COFFEE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const lines: DiscountLineItem[] = [
  { id: ITEM_A, quantity: 1, subtotal: 100 },
  { id: ITEM_B, quantity: 2, subtotal: 50 },
];

function promo(overrides: Partial<PromotionCandidate> & { id: string }): PromotionCandidate {
  return {
    name: 'Promo',
    discount_type: 'percent',
    discount_value: 10,
    applies_to: 'all',
    ...overrides,
  };
}

describe('evaluateCompatiblePromotions', () => {
  it('returns zero when there are no promotions', () => {
    expect(evaluateCompatiblePromotions([], lines)).toEqual({
      discountAmount: 0,
      appliedPromotions: [],
    });
  });

  it('applies the best percent discount across the cart', () => {
    const result = evaluateCompatiblePromotions(
      [
        promo({ id: 'p-10', name: '10% off', discount_value: 10 }),
        promo({ id: 'p-20', name: '20% off', discount_value: 20 }),
      ],
      lines
    );

    expect(result.discountAmount).toBe(30);
    expect(result.appliedPromotions).toEqual([
      expect.objectContaining({ id: 'p-20', name: '20% off', discount_amount: 30 }),
    ]);
  });

  it('applies selected_items by catalog item or category', () => {
    const selected: PromotionCandidate = promo({
      id: 'p-sel',
      name: 'Coffee 50',
      discount_type: 'percent',
      discount_value: 50,
      applies_to: 'selected_items',
      promotion_catalog_items: [{ catalog_item_id: ITEM_A }],
    });
    const byCategory: PromotionCandidate = promo({
      id: 'p-cat',
      name: 'Category 10',
      discount_type: 'percent',
      discount_value: 10,
      applies_to: 'selected_items',
      promotion_catalog_categories: [{ catalog_category_id: CAT_COFFEE }],
    });

    const byItem = evaluateCompatiblePromotions([selected], lines);
    expect(byItem.discountAmount).toBe(50);

    const byCat = evaluateCompatiblePromotions(
      [byCategory],
      lines,
      new Map([[ITEM_B, CAT_COFFEE]])
    );
    expect(byCat.discountAmount).toBe(5);
  });

  it('caps a fixed discount at the applicable subtotal and skips min_order_amount misses', () => {
    const fixed = evaluateCompatiblePromotions(
      [promo({ id: 'p-fixed', name: '40 off', discount_type: 'fixed', discount_value: 40 })],
      [{ id: ITEM_A, quantity: 1, subtotal: 25 }]
    );
    expect(fixed.discountAmount).toBe(25);

    const skipped = evaluateCompatiblePromotions(
      [promo({ id: 'p-min', discount_value: 50, min_order_amount: 200 })],
      lines
    );
    expect(skipped.discountAmount).toBe(0);
  });

  it('skips BOGO promotions', () => {
    const result = evaluateCompatiblePromotions(
      [promo({ id: 'p-bogo', discount_type: 'bogo', discount_value: 1 })],
      lines
    );
    expect(result.discountAmount).toBe(0);
  });
});

describe('formatAppliedPromotionsNotification', () => {
  it('tells the agent to relay the discounted total', () => {
    const text = formatAppliedPromotionsNotification(
      [{ id: 'p-20', name: '20% off', discount_amount: 20 }],
      100,
      20,
      80,
      'MXN'
    );
    expect(text).toContain('20% off');
    expect(text).toContain('MXN 80');
    expect(text).toContain('Tell the customer this discounted total');
  });
});
