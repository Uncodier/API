import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST as quotations } from '@/app/api/agents/tools/quotations/route';
import { POST as items } from '@/app/api/agents/tools/quotation_items/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { fireWorkflowDispatch } from '@/lib/services/workflow-robot/dispatch';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/workflow-robot/dispatch', () => ({ fireWorkflowDispatch: jest.fn() }));

type Row = Record<string, any>;
type Query = { table: string; operation: string; selection: string; filters: [string, unknown][]; payload?: Row; rows?: Row[]; range?: [number, number] };
const site = randomUUID();
const otherSite = randomUUID();
const sale = randomUUID();
const sealed = randomUUID();
const foreign = randomUUID();
const saleItem = randomUUID();
const sealedItem = randomUUID();
const foreignItem = randomUUID();
const catalog = randomUUID();
const foreignCatalog = randomUUID();
const priceList = randomUUID();
const lead = randomUUID();
const deal = randomUUID();
let db: Record<string, Row[]>;
let queries: Query[];
let intercept: (query: Query) => { data: null; error: { message: string } | null } | undefined;

// A service-role stand-in: no RLS or triggers. Only explicit query predicates
// protect fixtures, and every returned/mutated row is recorded for assertions.
function from(table: string) {
  const query: Query = { table, operation: 'select', selection: '*', filters: [] };
  queries.push(query);
  let single = false;
  const execute = () => {
    const failure = intercept(query);
    if (failure) return failure;
    const matches = (row: Row) => query.filters.every(([key, value]) => {
      const [relation, column] = key.split('.');
      if (!column) return row[key] === value;
      const parent = relation === 'quotations'
        ? db.quotations.find(q => q.id === row.quotation_id)
        : db.price_lists.find(p => p.id === row.price_list_id);
      // PostgREST embedded filters constrain root rows only with !inner.
      return !query.selection.includes(`${relation}!inner(`) || parent?.[column] === value;
    });
    let rows = db[table].filter(matches);
    if (query.operation === 'insert') {
      rows = [{ id: randomUUID(), ...query.payload }];
      db[table].push(...rows);
    }
    if (query.operation === 'update') rows.forEach(row => Object.assign(row, query.payload));
    if (query.operation === 'delete') db[table] = db[table].filter(row => !rows.includes(row));
    const count = rows.length;
    if (query.range) rows = rows.slice(query.range[0], query.range[1] + 1);
    query.rows = structuredClone(rows);
    return { data: single ? rows[0] ?? null : rows, count, error: null };
  };
  const builder: any = {
    select: (selection = '*') => { query.selection = selection; return builder; },
    eq: (key: string, value: unknown) => { query.filters.push([key, value]); return builder; },
    insert: (payload: Row) => { query.operation = 'insert'; query.payload = payload; return builder; },
    update: (payload: Row) => { query.operation = 'update'; query.payload = payload; return builder; },
    delete: () => { query.operation = 'delete'; return builder; },
    single: () => { single = true; return builder; },
    maybeSingle: () => { single = true; return builder; },
    range: (start: number, end: number) => { query.range = [start, end]; return builder; },
    order: () => builder,
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(execute()).then(resolve, reject),
  };
  return builder;
}

async function call(handler: typeof quotations, body: Row) {
  const response = await handler(new NextRequest('https://legacy.example.test/api/tools', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }));
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  queries = [];
  intercept = () => undefined;
  db = {
    leads: [{ id: lead, site_id: site }, { id: randomUUID(), site_id: otherSite }],
    deals: [{ id: deal, site_id: site }, { id: randomUUID(), site_id: otherSite }],
    quotations: [
      { id: sale, site_id: site, purpose: 'sales', price_list_id: priceList, notes: 'Sales quote' },
      { id: sealed, site_id: null, buyer_site_id: site, purpose: 'procurement', notes: 'Sealed proposal' },
      { id: foreign, site_id: otherSite, purpose: 'sales', notes: 'Other tenant' },
    ],
    quotation_items: [
      { id: saleItem, quotation_id: sale, name: 'Sales line', quantity: 2, unit_price: 10, subtotal: 20 },
      { id: sealedItem, quotation_id: sealed, name: 'Sealed line', quantity: 1, unit_price: 99, subtotal: 99 },
      { id: foreignItem, quotation_id: foreign, name: 'Other tenant line', quantity: 1, unit_price: 30, subtotal: 30 },
    ],
    catalog_items: [
      { id: catalog, site_id: site, name: 'Local catalog', target_sale_price: 10 },
      { id: foreignCatalog, site_id: otherSite, name: 'Foreign catalog', target_sale_price: 900 },
    ],
    price_lists: [{ id: priceList, site_id: site }],
    price_list_items: [{ price_list_id: priceList, catalog_item_id: catalog, unit_price: 8 }],
  };
  (supabaseAdmin.from as jest.Mock).mockImplementation(from);
});
afterEach(() => jest.restoreAllMocks());

describe.each([['quotations', quotations], ['quotation_items', items]] as const)('%s input and result boundaries', (_name, handler) => {
  it.each(['get', 'update', 'delete'])('requires a scalar nonblank id before %s', async action => {
    const before = structuredClone(db);
    for (const id of [undefined, null, '', ' ', false, [], {}]) {
      const result = await call(handler, { action, site_id: site, id, quantity: 5 });
      expect(result.status).toBe(400);
      expect(result.body.success).toBe(false);
    }
    expect(queries).toEqual([]);
    expect(db).toEqual(before);
  });

  it.each(['get', 'update', 'delete'])('does not report success for nonexistent %s targets', async action => {
    const before = structuredClone(db);
    const result = await call(handler, { action, site_id: site, id: randomUUID(), quantity: 5 });
    expect(result.body.success).toBe(false);
    expect(db).toEqual(before);
    expect(fireWorkflowDispatch).not.toHaveBeenCalled();
  });

  it.each([
    { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: '10' }, { limit: null },
    { limit: false }, { limit: {} }, { offset: -1 }, { offset: 0.5 }, { offset: '0' },
    { offset: null }, { offset: [] }, { offset: Number.MAX_SAFE_INTEGER, limit: 2 },
  ])('rejects invalid pagination before querying: %j', async pagination => {
    const result = await call(handler, { action: 'list', site_id: site, quotation_id: sale, ...pagination });
    expect(result.status).toBe(400);
    expect(queries).toEqual([]);
  });

  it('uses numeric inclusive list ranges and preserves total count', async () => {
    const result = await call(handler, { action: 'list', site_id: site, quotation_id: sale, offset: 1, limit: 2 });
    expect(result.body.success).toBe(true);
    expect(result.body.count).toBe(1);
    expect(result.body.quotations ?? result.body.items).toEqual([]);
    expect(queries.find(q => q.range)?.range).toEqual([1, 2]);
  });
});

describe.each([['quotations', quotations], ['quotation_items', items]] as const)('%s requires site scope', (_name, handler) => {
  it.each(['create', 'get', 'list', 'update', 'delete'])('rejects %s before any database access', async action => {
    for (const site_id of [undefined, null, '', ' ', false, {}]) {
      const result = await call(handler, { action, id: sealedItem, quotation_id: sealed, site_id });
      expect(result.status).toBe(400);
    }
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });
});

describe('legacy quotations', () => {
  it.each(['get', 'list', 'update', 'delete'])('constrains %s by site and sales purpose', async action => {
    // Also prove purpose filtering independently of the current DB constraint.
    db.quotations.find(q => q.id === sealed)!.site_id = site;
    const before = structuredClone(db);
    const result = await call(quotations, { action, site_id: site, id: sealed, notes: 'Overwrite', purpose: 'procurement' });
    const query = queries[0];
    expect(query.filters).toEqual(expect.arrayContaining([['site_id', site], ['purpose', 'sales']]));
    expect(query.rows!.every(row => row.purpose === 'sales' && row.site_id === site)).toBe(true);
    expect(JSON.stringify(result.body)).not.toMatch(/Sealed proposal|Other tenant/);
    expect(db.quotations.find(q => q.id === sealed)).toEqual(before.quotations.find(q => q.id === sealed));
    expect(fireWorkflowDispatch).not.toHaveBeenCalled();
    if (action !== 'list') expect(result.body.success).toBe(false);
  });

  it.each(['get', 'list', 'update', 'delete'])('preserves sales %s', async action => {
    const result = await call(quotations, { action, site_id: site, id: sale, notes: 'Updated sales' });
    expect(result.body.success).toBe(true);
    expect(queries[0].rows).toHaveLength(1);
    expect(queries[0].rows![0].id).toBe(sale);
  });

  it('creates only sales regardless of attempted procurement fields', async () => {
    const result = await call(quotations, { action: 'create', site_id: site, lead_id: lead, purpose: 'procurement', buyer_site_id: site, procurement_input: { sealed: true } });
    expect(result.body.quotation).toMatchObject({ site_id: site, purpose: 'sales' });
    const mutation = queries.find(q => q.operation === 'insert')!;
    expect(mutation.payload).not.toHaveProperty('buyer_site_id');
    expect(mutation.payload).not.toHaveProperty('procurement_input');
  });

  it.each([
    ['lead_id', 'leads', 'create'], ['deal_id', 'deals', 'create'],
    ['price_list_id', 'price_lists', 'create'], ['price_list_id', 'price_lists', 'update'],
  ])('rejects foreign or nonexistent %s on %s (%s)', async (field, table, action) => {
    const foreignId = randomUUID();
    db[table].push({ id: foreignId, site_id: otherSite });
    const before = structuredClone(db);
    for (const value of [foreignId, randomUUID()]) {
      const result = await call(quotations, { action, site_id: site, id: sale, lead_id: lead, [field]: value });
      expect(result.body.success).toBe(false);
    }
    expect(queries.every(q => q.operation === 'select')).toBe(true);
    expect(queries.filter(q => q.table === table).every(q => q.filters.some(([key, value]) => key === 'site_id' && value === site))).toBe(true);
    expect(db).toEqual(before);
    expect(fireWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('requires the canonical sales lead before creating a quotation', async () => {
    for (const lead_id of [undefined, null, '', ' ', false, {}]) {
      const result = await call(quotations, { action: 'create', site_id: site, lead_id });
      expect(result.body.success).toBe(false);
    }
    expect(queries).toEqual([]);
  });

  it('accepts local references without inventing buyer-user membership restrictions', async () => {
    const buyer = randomUUID();
    const result = await call(quotations, {
      action: 'create', site_id: site, lead_id: lead, deal_id: deal, price_list_id: priceList, buyer_user_id: buyer,
    });
    expect(result.body.quotation).toMatchObject({ lead_id: lead, deal_id: deal, price_list_id: priceList, buyer_user_id: buyer });
    expect(result.body.success).toBe(true);
    const cleared = await call(quotations, { action: 'update', site_id: site, id: sale, price_list_id: null });
    expect(cleared.body.quotation.price_list_id).toBeNull();
    expect(fireWorkflowDispatch).toHaveBeenCalledTimes(2);
  });
});

describe('legacy quotation items', () => {
  it.each(['create', 'list'])('requires a scalar parent id before %s', async action => {
    for (const quotation_id of [undefined, null, '', ' ', false, [], {}]) {
      const result = await call(items, { action, site_id: site, quotation_id });
      expect(result.status).toBe(400);
    }
    expect(queries).toEqual([]);
  });

  it.each(['create', 'get', 'list', 'update', 'delete'])('never fetches or mutates sealed/cross-site content on %s', async action => {
    // Include a sales-site value on procurement to require the purpose guard too.
    db.quotations.find(q => q.id === sealed)!.site_id = site;
    const before = structuredClone(db);
    for (const [id, quotation_id] of [[sealedItem, sealed], [foreignItem, foreign]]) {
      const result = await call(items, { action, site_id: site, id, quotation_id, name: 'Overwrite', quantity: 3 });
      expect(result.body.success).toBe(false);
      expect(JSON.stringify(result.body)).not.toMatch(/Sealed|Other tenant/);
    }
    expect(queries.every(q => q.operation === 'select' && q.rows?.length === 0)).toBe(true);
    expect(db).toEqual(before);
  });

  it.each(['create', 'get', 'list', 'update', 'delete'])('preserves sales %s and scopes totals', async action => {
    const result = await call(items, { action, site_id: site, id: saleItem, quotation_id: sale, name: 'New line', unit_price: 5, quantity: 3 });
    expect(result.body.success).toBe(true);
    for (const query of queries.filter(q => q.table === 'quotations')) {
      expect(query.filters).toEqual(expect.arrayContaining([['site_id', site], ['purpose', 'sales']]));
    }
    for (const query of queries.filter(q => q.table === 'quotation_items' && ['update', 'delete'].includes(q.operation))) {
      expect(query.filters).toContainEqual(['quotation_id', sale]);
    }
    expect(queries.flatMap(q => q.rows || []).some(row => [sealed, sealedItem, foreign, foreignItem].includes(row.id))).toBe(false);
  });

  it('ignores attempted reparenting and procurement state on update', async () => {
    await call(items, { action: 'update', site_id: site, id: saleItem, quotation_id: sealed, procurement_unit_net_minor: 1 });
    const mutation = queries.find(q => q.table === 'quotation_items' && q.operation === 'update')!;
    expect(mutation.payload).not.toHaveProperty('quotation_id');
    expect(mutation.payload).not.toHaveProperty('procurement_unit_net_minor');
    expect(db.quotation_items.find(i => i.id === saleItem)!.quotation_id).toBe(sale);
  });

  it.each([{}, { name: 'Caller name', unit_price: 1 }])('rejects foreign catalog items even with caller overrides: %j', async overrides => {
    const result = await call(items, { action: 'create', site_id: site, quotation_id: sale, catalog_item_id: foreignCatalog, ...overrides });
    expect(result.body.success).toBe(false);
    expect(queries.find(q => q.table === 'catalog_items')!.filters).toContainEqual(['site_id', site]);
    expect(queries.every(q => q.operation === 'select')).toBe(true);
    expect(queries.find(q => q.table === 'catalog_items')!.rows).toEqual([]);
  });

  it.each([site, otherSite])('hydrates only site-scoped catalog and price-list values (%s)', async priceListSite => {
    db.price_lists[0].site_id = priceListSite;
    const result = await call(items, { action: 'create', site_id: site, quotation_id: sale, catalog_item_id: catalog });
    expect(result.body.item).toMatchObject({ name: 'Local catalog', unit_price: priceListSite === site ? 8 : 10 });
    const lookup = queries.find(q => q.table === 'price_list_items')!;
    expect(lookup.selection).toContain('price_lists!inner(site_id)');
    expect(lookup.filters).toContainEqual(['price_lists.site_id', site]);
    if (priceListSite !== site) expect(lookup.rows).toEqual([]);
  });

  it.each(['update', 'delete'])('does not report success if the item disappears before %s', async action => {
    intercept = query => query.table === 'quotation_items' && query.operation === action
      ? { data: null, error: null } : undefined;
    const result = await call(items, { action, site_id: site, id: saleItem });
    expect(result.body.success).toBe(false);
    expect(queries.some(q => q.table === 'quotations' && q.operation === 'update')).toBe(false);
  });

  it.each(['create', 'update', 'delete'])('surfaces totals read/write errors after %s', async action => {
    for (const stage of ['read', 'write', 'missing-parent']) {
      queries = [];
      const beforeTotals = structuredClone(db.quotations);
      intercept = query => {
        const totalsRead = query.table === 'quotation_items' && query.selection.startsWith('subtotal,');
        const totalsWrite = query.table === 'quotations' && query.operation === 'update';
        if ((stage === 'read' && totalsRead) || (stage !== 'read' && totalsWrite)) {
          return { data: null, error: stage === 'missing-parent' ? null : { message: `Totals ${stage} failed` } };
        }
      };
      // Restore the target for each independent failure scenario (delete removes it).
      if (!db.quotation_items.some(row => row.id === saleItem)) {
        db.quotation_items.push({ id: saleItem, quotation_id: sale, quantity: 2, unit_price: 10, subtotal: 20 });
      }
      const result = await call(items, { action, site_id: site, id: saleItem, quotation_id: sale, name: 'Sales line', quantity: 3 });
      expect(result.status).toBe(500);
      expect(result.body.success).toBe(false);
      expect(result.body.error).toContain(stage === 'missing-parent' ? 'Quotation not found' : `Totals ${stage} failed`);
      expect(db.quotations).toEqual(beforeTotals);
      if (stage === 'read') expect(queries.some(q => q.table === 'quotations' && q.operation === 'update')).toBe(false);
    }
  });

  it('does not silently use catalog pricing when the price-list lookup fails', async () => {
    intercept = query => query.table === 'price_list_items' ? { data: null, error: { message: 'Price lookup failed' } } : undefined;
    const result = await call(items, { action: 'create', site_id: site, quotation_id: sale, catalog_item_id: catalog });
    expect(result.body).toMatchObject({ success: false, error: 'Price lookup failed' });
    expect(queries.every(q => q.operation === 'select')).toBe(true);
  });
});