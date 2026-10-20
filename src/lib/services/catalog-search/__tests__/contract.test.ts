import { catalogSearchSchema, normalizeCatalogQuery, canonicalJson, fuseCatalogCandidates } from '../contract';

const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
describe('catalog search contract', () => {
  it('requires site for private/shop channels and hard bounds input', () => {
    expect(catalogSearchSchema.safeParse({ channel: 'catalog', query: 'test' }).success).toBe(false);
    for (const override of [{ limit: 101 }, { offset: -1 }, { limit: 1.2 }, { query: 'a'.repeat(201) }, { filters: { secret: true } }]) {
      expect(catalogSearchSchema.safeParse({ channel: 'marketplace', query: 'test', ...override }).success).toBe(false);
    }
    expect(catalogSearchSchema.parse({ channel: 'shop', site_id: id, query: 'test', filters: { category_id: null } }).filters.category_id).toBeNull();
  });
  it('normalizes only layout and NFC, keeping intent and accents', () => {
    expect(normalizeCatalogQuery('  sin   azúcar  ')).toBe('sin azúcar');
    expect(normalizeCatalogQuery('no café')).not.toBe(normalizeCatalogQuery('café'));
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });
  it('prioritizes exact matches and fuses rankings rather than incomparable scores', () => {
    const exact = { id, site_id: id, score: .01, exact_match: true };
    const similar = { id: other, site_id: id, score: 900, exact_match: false };
    const fused = fuseCatalogCandidates([exact, similar], [similar]);
    expect(fused.map(item => item.id)).toEqual([id, other]);
    expect(fused[1].score).toBeLessThan(1);
    expect(fused).toHaveLength(2);
  });
});