import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/agents/tools/catalog_commerce/route';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

function chainBase(resolved: { data?: unknown; error?: { message: string; code?: string } | null } = {}) {
  const result = {
    data: resolved.data ?? null,
    error: resolved.error ?? null,
    count: Array.isArray(resolved.data) ? resolved.data.length : undefined,
  };
  const chain: any = {
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(result),
    maybeSingle: jest.fn().mockResolvedValue(result),
  };
  chain.order.mockImplementation(() => {
    const dual = {
      ...chain,
      order: jest.fn().mockResolvedValue(result),
    };
    return dual;
  });
  chain.range.mockResolvedValue(result);
  return chain;
}

describe('catalog_commerce specs and taxes', () => {
  const siteId = 'site-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a spec category and auto-generates slug', async () => {
    const created = { id: 'sc-1', site_id: siteId, name: 'Dimensions', slug: 'dimensions' };
    const chain = chainBase({ data: created });
    (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        resource: 'item_spec_category',
        site_id: siteId,
        name: 'Dimensions',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        site_id: siteId,
        name: 'Dimensions',
        slug: 'dimensions',
      })
    );
  });

  it('creates an item spec', async () => {
    const created = { id: 'sp-1', site_id: siteId, category_id: 'sc-1', name: '120 x 60 cm' };
    const chain = chainBase({ data: created });
    (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        resource: 'item_spec',
        site_id: siteId,
        category_id: 'sc-1',
        name: '120 x 60 cm',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.item_spec.name).toBe('120 x 60 cm');
  });

  it('attaches a spec after validating site ownership', async () => {
    const itemChain = chainBase({ data: { id: 'cat-1', site_id: siteId } });
    const specChain = chainBase({ data: { id: 'sp-1', site_id: siteId } });
    const attachChain = chainBase({
      data: { catalog_item_id: 'cat-1', item_spec_id: 'sp-1', sort_order: 0 },
    });

    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'catalog_items') return itemChain;
      if (table === 'item_specs') return specChain;
      if (table === 'catalog_item_specs') return attachChain;
      return chainBase();
    });

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        resource: 'catalog_item_spec',
        site_id: siteId,
        catalog_item_id: 'cat-1',
        item_spec_id: 'sp-1',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.catalog_item_spec.item_spec_id).toBe('sp-1');
  });

  it('creates a tax', async () => {
    const created = { id: 'tax-1', site_id: siteId, name: 'IVA', rate: 16, is_active: true };
    const chain = chainBase({ data: created });
    (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        resource: 'tax',
        site_id: siteId,
        name: 'IVA',
        rate: 16,
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.tax.rate).toBe(16);
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: siteId, name: 'IVA', rate: 16 })
    );
  });

  it('rejects a tax rate outside 0-100', async () => {
    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        resource: 'tax',
        site_id: siteId,
        name: 'IVA',
        rate: 140,
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/0 and 100/);
  });

  it('attaches a tax after validating site ownership', async () => {
    const itemChain = chainBase({ data: { id: 'cat-1', site_id: siteId } });
    const taxChain = chainBase({ data: { id: 'tax-1', site_id: siteId } });
    const attachChain = chainBase({
      data: { id: 'cit-1', catalog_item_id: 'cat-1', tax_id: 'tax-1' },
    });

    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'catalog_items') return itemChain;
      if (table === 'taxes') return taxChain;
      if (table === 'catalog_item_taxes') return attachChain;
      return chainBase();
    });

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        resource: 'catalog_item_tax',
        site_id: siteId,
        catalog_item_id: 'cat-1',
        tax_id: 'tax-1',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.catalog_item_tax.tax_id).toBe('tax-1');
  });
});
