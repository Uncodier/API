import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/agents/tools/catalog_commerce/route';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';
import {
  buildCatalogSearchClauses,
  catalogSearchFallbackHint,
  splitSearchTokens,
} from '../../src/app/api/agents/tools/catalog_commerce/handlers/catalog-search';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('buildCatalogSearchClauses', () => {
  it('splits multi-word search into tokens of 3+ chars', () => {
    expect(splitSearchTokens('corte caballero')).toEqual(['corte', 'caballero']);
  });

  it('builds a token fallback for phrases that would miss short item names', () => {
    const clauses = buildCatalogSearchClauses('corte caballero');
    expect(clauses).toEqual({
      phrase: 'corte caballero',
      tokens: ['corte', 'caballero'],
      phraseFilter: 'name.ilike.%corte caballero%,description.ilike.%corte caballero%',
      tokenFilter:
        'name.ilike.%corte%,description.ilike.%corte%,name.ilike.%caballero%,description.ilike.%caballero%',
    });
  });

  it('does not fallback when the search is already a single token', () => {
    const clauses = buildCatalogSearchClauses('corte');
    expect(clauses?.tokenFilter).toBeNull();
    expect(clauses?.phraseFilter).toBe('name.ilike.%corte%,description.ilike.%corte%');
  });

  it('falls back to the remaining token when short words pad the phrase', () => {
    const clauses = buildCatalogSearchClauses('el corte');
    expect(clauses?.tokens).toEqual(['corte']);
    expect(clauses?.tokenFilter).toBe('name.ilike.%corte%,description.ilike.%corte%');
  });
});

describe('catalog_commerce list search', () => {
  const siteId = 'site-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockListChain(result: { data: unknown[]; count: number; error?: { message: string } | null }) {
    const or = jest.fn().mockReturnThis();
    const eq = jest.fn().mockReturnThis();
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      eq,
      or,
      range: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({
        data: result.data,
        count: result.count,
        error: result.error ?? null,
      }),
    };
    return chain;
  }

  it('falls back to token search and returns search_hint when the phrase misses', async () => {
    const corteItems = [
      {
        id: 'item-corte',
        site_id: siteId,
        name: 'Corte',
        kind: 'service',
        target_sale_price: 250,
        currency: 'MXN',
      },
    ];
    const phraseChain = mockListChain({ data: [], count: 0 });
    const tokenChain = mockListChain({ data: corteItems, count: 1 });
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(phraseChain)
      .mockReturnValueOnce(tokenChain);

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'list',
        site_id: siteId,
        search: 'corte caballero',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.items).toEqual(corteItems);
    expect(json.count).toBe(1);
    expect(json.search_hint).toBe(
      catalogSearchFallbackHint('corte caballero', ['corte', 'caballero'])
    );
    expect(phraseChain.or).toHaveBeenCalledWith(
      'name.ilike.%corte caballero%,description.ilike.%corte caballero%'
    );
    expect(tokenChain.or).toHaveBeenCalledWith(
      'name.ilike.%corte%,description.ilike.%corte%,name.ilike.%caballero%,description.ilike.%caballero%'
    );
    expect(supabaseAdmin.from).toHaveBeenCalledTimes(2);
  });

  it('does not fallback when the phrase already matches', async () => {
    const corteItems = [
      {
        id: 'item-corte',
        site_id: siteId,
        name: 'Corte',
        kind: 'service',
        target_sale_price: 250,
        currency: 'MXN',
      },
    ];
    const phraseChain = mockListChain({ data: corteItems, count: 1 });
    (supabaseAdmin.from as jest.Mock).mockReturnValue(phraseChain);

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'list',
        site_id: siteId,
        search: 'corte',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.items).toEqual(corteItems);
    expect(json.search_hint).toBeUndefined();
    expect(phraseChain.or).toHaveBeenCalledTimes(1);
    expect(phraseChain.or).toHaveBeenCalledWith('name.ilike.%corte%,description.ilike.%corte%');
    expect(supabaseAdmin.from).toHaveBeenCalledTimes(1);
  });
});
