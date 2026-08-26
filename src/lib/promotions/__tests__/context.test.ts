import {
  formatActivePromotionsForContext,
  appendActivePromotionsToContext,
  type ActivePromotionRow,
} from '../context';

describe('formatActivePromotionsForContext', () => {
  it('tells the agent to look up promotions when the snapshot is empty', () => {
    const text = formatActivePromotionsForContext([]);

    expect(text).toContain('=== ACTIVE PROMOTIONS (hint) ===');
    expect(text).toContain('No active promotions');
    expect(text).toContain('promotions.list');
  });

  it('lists compact active promotion lines', () => {
    const rows: ActivePromotionRow[] = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: '20% off coffee',
        code: 'COFFEE20',
        discount_type: 'percent',
        discount_value: 20,
        applies_to: 'selected_items',
        starts_at: '2026-08-01T00:00:00.000Z',
        ends_at: '2026-08-31T23:59:59.000Z',
        channels: ['shop', 'pos'],
      },
    ];

    const text = formatActivePromotionsForContext(rows);

    expect(text).toContain('id=44444444-4444-4444-8444-444444444444');
    expect(text).toContain('20% off coffee');
    expect(text).toContain('code=COFFEE20');
    expect(text).toContain('discount=20%');
    expect(text).toContain('applies_to=selected_items');
    expect(text).toContain('channels=shop,pos');
    expect(text).not.toContain('No active promotions');
  });
});

describe('appendActivePromotionsToContext', () => {
  it('skips the snapshot when site_id is missing or not a UUID', async () => {
    const original = 'hello';
    expect(await appendActivePromotionsToContext(original, null)).toBe(original);
    expect(await appendActivePromotionsToContext(original, 'not-a-uuid')).toBe(original);
  });
});
