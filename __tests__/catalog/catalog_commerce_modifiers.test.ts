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
  // list paths resolve on order/range
  chain.order.mockImplementation(() => {
    const ordered = { ...chain, then: undefined };
    ordered.order = jest.fn().mockResolvedValue(result);
    // dual order() chains in list
    const dual = {
      ...chain,
      order: jest.fn().mockResolvedValue(result),
    };
    return dual;
  });
  chain.range.mockResolvedValue(result);
  return chain;
}

describe('catalog_commerce modifiers', () => {
  const siteId = 'site-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a modifier group', async () => {
    const created = {
      id: 'mg-1',
      site_id: siteId,
      name: 'Milk options',
      min_select: 0,
      max_select: 1,
    };
    const chain = chainBase({ data: created });
    (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        resource: 'modifier_group',
        site_id: siteId,
        name: 'Milk options',
        min_select: 0,
        max_select: 1,
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.modifier_group.name).toBe('Milk options');
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        site_id: siteId,
        name: 'Milk options',
        min_select: 0,
        max_select: 1,
      })
    );
  });

  it('adds a modifier group item after validating site ownership', async () => {
    const groupChain = chainBase({ data: { id: 'mg-1', site_id: siteId } });
    const itemChain = chainBase({ data: { id: 'cat-opt', site_id: siteId } });
    const insertChain = chainBase({
      data: {
        id: 'mgi-1',
        modifier_group_id: 'mg-1',
        catalog_item_id: 'cat-opt',
      },
    });

    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'modifier_groups') return groupChain;
      if (table === 'catalog_items') return itemChain;
      if (table === 'modifier_group_items') return insertChain;
      return chainBase();
    });

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        resource: 'modifier_group_item',
        site_id: siteId,
        modifier_group_id: 'mg-1',
        catalog_item_id: 'cat-opt',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.modifier_group_item.catalog_item_id).toBe('cat-opt');
  });

  it('attaches a modifier group to a host catalog item', async () => {
    const hostChain = chainBase({ data: { id: 'cat-host', site_id: siteId } });
    const groupChain = chainBase({ data: { id: 'mg-1', site_id: siteId } });
    const attachChain = chainBase({
      data: {
        id: 'cimg-1',
        catalog_item_id: 'cat-host',
        modifier_group_id: 'mg-1',
      },
    });

    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'catalog_items') return hostChain;
      if (table === 'modifier_groups') return groupChain;
      if (table === 'catalog_item_modifier_groups') return attachChain;
      return chainBase();
    });

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        resource: 'item_modifier_group',
        site_id: siteId,
        catalog_item_id: 'cat-host',
        modifier_group_id: 'mg-1',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.item_modifier_group.modifier_group_id).toBe('mg-1');
  });

  it('deletes a modifier group', async () => {
    const chain = chainBase({ data: null });
    (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'delete',
        resource: 'modifier_group',
        site_id: siteId,
        id: 'mg-1',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(chain.delete).toHaveBeenCalled();
  });

  it('gets an item with include_modifiers', async () => {
    const item = { id: 'cat-host', site_id: siteId, name: 'Cold Brew' };
    const itemChain = chainBase({ data: item });
    const attachChain = {
      ...chainBase({
        data: [{ id: 'att-1', modifier_group_id: 'mg-1', sort_order: 0 }],
      }),
      order: jest.fn().mockResolvedValue({
        data: [{ id: 'att-1', modifier_group_id: 'mg-1', sort_order: 0 }],
        error: null,
      }),
    };
    const groupsChain = {
      ...chainBase(),
      in: jest.fn().mockResolvedValue({
        data: [{ id: 'mg-1', name: 'Milk options', min_select: 0, max_select: 1 }],
        error: null,
      }),
    };
    const optionsChain = {
      ...chainBase(),
      in: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({
        data: [
          {
            id: 'mgi-1',
            modifier_group_id: 'mg-1',
            catalog_item_id: 'cat-opt',
            catalog_item: { id: 'cat-opt', name: 'Oat milk', target_sale_price: 10 },
          },
        ],
        error: null,
      }),
    };

    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'catalog_items') return itemChain;
      if (table === 'catalog_item_modifier_groups') return attachChain;
      if (table === 'modifier_groups') return groupsChain;
      if (table === 'modifier_group_items') return optionsChain;
      return chainBase();
    });

    const req = new NextRequest('http://localhost/api/agents/tools/catalog_commerce', {
      method: 'POST',
      body: JSON.stringify({
        action: 'get',
        resource: 'item',
        id: 'cat-host',
        site_id: siteId,
        include_modifiers: true,
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.item.name).toBe('Cold Brew');
    expect(json.modifiers).toHaveLength(1);
    expect(json.modifiers[0].group.name).toBe('Milk options');
    expect(json.modifiers[0].group.options[0].catalog_item.name).toBe('Oat milk');
  });
});
