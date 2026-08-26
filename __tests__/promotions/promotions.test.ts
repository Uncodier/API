import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/agents/tools/promotions/route';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN_ID = '33333333-3333-4333-8333-333333333333';
const PROMO_ID = '44444444-4444-4444-8444-444444444444';
const ITEM_ID = '55555555-5555-4555-8555-555555555555';

function thenableChain(resolved: { data?: unknown; error?: unknown; count?: number | null }) {
  const result = {
    data: resolved.data ?? null,
    error: resolved.error ?? null,
    count: resolved.count ?? null,
  };
  const chain: Record<string, jest.Mock | ((onFulfilled: unknown, onRejected?: unknown) => Promise<unknown>)> = {};
  const self = () => chain;
  for (const method of [
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'or',
    'in',
    'is',
    'lte',
    'gte',
    'ilike',
    'range',
    'order',
    'limit',
    'neq',
  ]) {
    chain[method] = jest.fn(self);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  chain.then = (onFulfilled: unknown, onRejected?: unknown) =>
    Promise.resolve(result).then(onFulfilled as (value: unknown) => unknown, onRejected as (reason: unknown) => unknown);
  return chain;
}

describe('promotions CRUD', () => {
  const created = {
    id: PROMO_ID,
    site_id: SITE_ID,
    campaign_id: CAMPAIGN_ID,
    name: '20% off coffee',
    discount_type: 'percent',
    discount_value: 20,
    status: 'draft',
    applies_to: 'all',
    catalog_items: [],
    catalog_categories: [],
    required_items: [],
    required_categories: [],
  };

  let inserts: Record<string, unknown>;
  let deletes: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    inserts = {};
    deletes = [];

    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'sites') {
        return thenableChain({ data: { user_id: USER_ID } });
      }

      const chain = thenableChain({
        data: table === 'promotions' ? created : [{ id: 'j-1' }],
        count: 1,
      });

      chain.insert = jest.fn((payload: unknown) => {
        inserts[table] = payload;
        return chain;
      });
      chain.delete = jest.fn(() => {
        deletes.push(table);
        return chain;
      });
      if (table === 'promotions') {
        chain.update = jest.fn((payload: unknown) => {
          inserts[`${table}:update`] = payload;
          return chain;
        });
      }
      return chain;
    });
  });

  async function post(body: Record<string, unknown>) {
    const req = new NextRequest('http://localhost/api/agents/tools/promotions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    return { res, json: await res.json() };
  }

  it('creates a promotion and resolves user_id from the site', async () => {
    const { res, json } = await post({
      action: 'create',
      site_id: SITE_ID,
      campaign_id: CAMPAIGN_ID,
      name: '20% off coffee',
      discount_type: 'percent',
      discount_value: 20,
    });

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.promotion.name).toBe('20% off coffee');
    expect(inserts.promotions).toEqual(
      expect.objectContaining({
        site_id: SITE_ID,
        user_id: USER_ID,
        campaign_id: CAMPAIGN_ID,
        name: '20% off coffee',
        discount_type: 'percent',
        discount_value: 20,
      })
    );
  });

  it('rejects create without name', async () => {
    const { res, json } = await post({
      action: 'create',
      site_id: SITE_ID,
      campaign_id: CAMPAIGN_ID,
      discount_type: 'percent',
      discount_value: 20,
    });

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/name|Required/i);
  });

  it('rejects selected_items without catalog targets', async () => {
    const { res, json } = await post({
      action: 'create',
      site_id: SITE_ID,
      campaign_id: CAMPAIGN_ID,
      name: 'Item promo',
      discount_type: 'percent',
      discount_value: 10,
      applies_to: 'selected_items',
    });

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/catalog_item_ids or catalog_category_ids/i);
  });

  it('creates selected_items promo with catalog_item_ids', async () => {
    const { res, json } = await post({
      action: 'create',
      site_id: SITE_ID,
      campaign_id: CAMPAIGN_ID,
      name: 'Coffee only',
      discount_type: 'percent',
      discount_value: 15,
      applies_to: 'selected_items',
      catalog_item_ids: [ITEM_ID],
    });

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(inserts.promotion_catalog_items).toEqual([
      expect.objectContaining({
        promotion_id: PROMO_ID,
        site_id: SITE_ID,
        catalog_item_id: ITEM_ID,
      }),
    ]);
  });

  it('replaces junctions on update when arrays are provided', async () => {
    const { res, json } = await post({
      action: 'update',
      id: PROMO_ID,
      site_id: SITE_ID,
      catalog_item_ids: [ITEM_ID],
    });

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(deletes).toContain('promotion_catalog_items');
    expect(inserts.promotion_catalog_items).toEqual([
      expect.objectContaining({ catalog_item_id: ITEM_ID, promotion_id: PROMO_ID }),
    ]);
  });

  it('allows update of a selected_items promo without resending catalog ids', async () => {
    const { res, json } = await post({
      action: 'update',
      id: PROMO_ID,
      site_id: SITE_ID,
      applies_to: 'selected_items',
      status: 'paused',
    });

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(inserts['promotions:update']).toEqual(
      expect.objectContaining({
        applies_to: 'selected_items',
        status: 'paused',
      })
    );
    expect(inserts.promotion_catalog_items).toBeUndefined();
  });

  it('accepts promotion_id alias for get', async () => {
    const { res, json } = await post({
      action: 'get',
      promotion_id: PROMO_ID,
      site_id: SITE_ID,
    });

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.promotion.id).toBe(PROMO_ID);
  });

  it('lists promotions for a site', async () => {
    const { res, json } = await post({
      action: 'list',
      site_id: SITE_ID,
      status: 'active',
    });

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.promotions).toEqual(created);
    expect(json.count).toBe(1);
  });

  it('deletes a promotion', async () => {
    const { res, json } = await post({
      action: 'delete',
      id: PROMO_ID,
      site_id: SITE_ID,
    });

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(true);
    expect(json.id).toBe(PROMO_ID);
  });

  it('maps unique code violations to 400', async () => {
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'sites') {
        return thenableChain({ data: { user_id: USER_ID } });
      }
      const chain = thenableChain({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      });
      chain.insert = jest.fn(() => chain);
      return chain;
    });

    const { res, json } = await post({
      action: 'create',
      site_id: SITE_ID,
      campaign_id: CAMPAIGN_ID,
      name: 'Dup',
      discount_type: 'percent',
      discount_value: 5,
      code: 'COFFEE20',
    });

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/already exists/i);
  });

  it('rejects missing action', async () => {
    const { res, json } = await post({ site_id: SITE_ID });
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/action/i);
  });
});
