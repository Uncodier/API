import { catalogPageCursor, catalogPagination } from '../catalog-pagination';
import { catalogQuerySchema } from '../catalog-service';
import { toolCatalogQuery } from '../tool-catalog';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
const site_id = '11111111-1111-4111-8111-111111111111';

it('encodes direct provider pages with the exact list limit', () => {
  expect(catalogPageCursor(1, 50)).toBeUndefined();
  expect(Buffer.from(catalogPageCursor(37, 50)!, 'base64').toString()).toBe('37-50');
  expect(Buffer.from(catalogPageCursor(4, 20)!, 'base64').toString()).toBe('4-20');
  expect(catalogPagination(4, 20, 61, false)).toMatchObject({ current_page: 4, total_pages: 4, has_next: false });
  expect(catalogPagination(1, 50, null, true).total_pages).toBeNull();
});

it.each([0, -1, 1.5, 100001, 'invalid'])('rejects invalid page %s at both routes', page => {
  expect(catalogQuerySchema.safeParse({ site_id, page }).success).toBe(false);
  expect(toolCatalogQuery.safeParse({ site_id, page }).success).toBe(false);
});

it('rejects ambiguous cursor and page requests', () => {
  expect(catalogQuerySchema.safeParse({ site_id, page: 2, cursor: 'next' }).success).toBe(false);
  expect(toolCatalogQuery.safeParse({ site_id, page: 2, cursor: 'next' }).success).toBe(false);
});