import {
  isItemBookable,
  isRowBookable,
  filterBookableFamily,
  assertCatalogItemBookable,
} from '../../src/lib/helpers/catalog-bookable';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('Catalog Bookable Helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isRowBookable', () => {
    it('requires active and available', () => {
      expect(isRowBookable('active', 'available')).toBe(true);
      expect(isRowBookable('archived', 'available')).toBe(false);
      expect(isRowBookable('active', 'unavailable')).toBe(false);
    });
  });

  describe('isItemBookable', () => {
    it('returns true if item is active/available and has no parent', () => {
      expect(isItemBookable({ id: '1', name: 'A', status: 'active', availability_status: 'available' })).toBe(true);
    });

    it('returns false if item is archived', () => {
      expect(isItemBookable({ id: '1', name: 'A', status: 'archived', availability_status: 'available' })).toBe(false);
    });

    it('returns false if item is unavailable', () => {
      expect(isItemBookable({ id: '1', name: 'A', status: 'active', availability_status: 'unavailable' })).toBe(false);
    });

    it('returns true if item and parent are both active/available', () => {
      expect(isItemBookable({
        id: 'child', name: 'C', status: 'active', availability_status: 'available',
        parent_id: 'parent',
        parent: { id: 'parent', name: 'P', status: 'active', availability_status: 'available' }
      })).toBe(true);
    });

    it('returns false if parent is archived', () => {
      expect(isItemBookable({
        id: 'child', name: 'C', status: 'active', availability_status: 'available',
        parent_id: 'parent',
        parent: { id: 'parent', name: 'P', status: 'archived', availability_status: 'available' }
      })).toBe(false);
    });

    it('returns false if parent is unavailable', () => {
      expect(isItemBookable({
        id: 'child', name: 'C', status: 'active', availability_status: 'available',
        parent_id: 'parent',
        parent: { id: 'parent', name: 'P', status: 'active', availability_status: 'unavailable' }
      })).toBe(false);
    });

    it('fails closed when parent_id is set but parent is missing', () => {
      expect(isItemBookable({
        id: 'child', name: 'C', status: 'active', availability_status: 'available',
        parent_id: 'parent',
      })).toBe(false);
    });

    it('reads the first parent when PostgREST returns an array', () => {
      expect(isItemBookable({
        id: 'child', name: 'C', status: 'active', availability_status: 'available',
        parent_id: 'parent',
        parent: [{ id: 'parent', name: 'P', status: 'archived', availability_status: 'unavailable' }],
      })).toBe(false);
    });
  });

  describe('filterBookableFamily', () => {
    it('hides children of an unavailable parent even when the child row is active', () => {
      const items = [
        { id: 'carlos', name: 'CARLOS', status: 'archived', availability_status: 'unavailable', parent_id: null },
        { id: 'corte', name: 'Corte', status: 'active', availability_status: 'available', parent_id: 'carlos' },
        { id: 'mauricio', name: 'MAURICIO', status: 'active', availability_status: 'available', parent_id: null },
        { id: 'corte-m', name: 'Corte', status: 'active', availability_status: 'available', parent_id: 'mauricio' },
      ];
      expect(filterBookableFamily(items).map((item) => item.id)).toEqual(['mauricio', 'corte-m']);
    });
  });

  describe('assertCatalogItemBookable', () => {
    it('throws if catalog item is not found', async () => {
      (supabaseAdmin.from as jest.Mock).mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null, error: new Error('not found') }),
      }));

      await expect(assertCatalogItemBookable('missing')).rejects.toThrow('Catalog item not found: missing');
    });

    it('throws if parent is unavailable', async () => {
      const rows: Record<string, any> = {
        child: {
          id: 'child', name: 'C', status: 'active', availability_status: 'available', parent_id: 'parent',
        },
        parent: {
          id: 'parent', name: 'P', status: 'active', availability_status: 'unavailable',
        },
      };
      (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
        const state: { id?: string } = {};
        const api: any = {
          select: () => api,
          eq: (col: string, val: string) => {
            if (col === 'id') state.id = val;
            return api;
          },
          maybeSingle: async () => ({ data: (state.id && rows[state.id]) || null, error: null }),
        };
        return api;
      });

      await expect(assertCatalogItemBookable('child')).rejects.toThrow(
        'Catalog item C or its parent is archived or unavailable'
      );
    });

    it('succeeds if both are active', async () => {
      const rows: Record<string, any> = {
        child: {
          id: 'child', name: 'C', status: 'active', availability_status: 'available', parent_id: 'parent',
        },
        parent: {
          id: 'parent', name: 'P', status: 'active', availability_status: 'available',
        },
      };
      (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
        const state: { id?: string } = {};
        const api: any = {
          select: () => api,
          eq: (col: string, val: string) => {
            if (col === 'id') state.id = val;
            return api;
          },
          maybeSingle: async () => ({ data: (state.id && rows[state.id]) || null, error: null }),
        };
        return api;
      });

      await expect(assertCatalogItemBookable('child')).resolves.toBeUndefined();
    });
  });
});
