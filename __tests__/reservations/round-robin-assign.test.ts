import {
  classifyRoundRobinRole,
  resolveRoundRobinCatalogItem,
} from '../../src/lib/reservations/round-robin-assign';
import { catalogItemCoveredByPass, resolveReservationEntitlement } from '../../src/lib/reservations/pass-redemption';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

const siteId = 'site-1';
const start = '2026-08-27T17:00:00.000Z';
const end = '2026-08-27T18:00:00.000Z';
const emmanuel = 'parent-emmanuel';
const corte = 'var-emmanuel-corte';
const barba = 'var-emmanuel-barba';
const mauricio = 'parent-mauricio';
const mauCorte = 'var-mauricio-corte';
const mauBarba = 'var-mauricio-barba';
const anyParent = 'parent-any';
const anyCorte = 'var-any-corte';
const anyBarba = 'var-any-barba';

const item = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id,
  parent_id: null,
  site_id: siteId,
  redeem_assignment_mode: 'user_choice',
  digital_subtype: null,
  is_reservation: true,
  status: 'active',
  availability_status: 'available',
  ...overrides,
});

const familyItems = [
  item(emmanuel, { name: 'EMMANUEL' }),
  item(corte, { name: 'Corte', parent_id: emmanuel }),
  item(barba, { name: 'Barba', parent_id: emmanuel }),
  item(mauricio, { name: 'MAURICIO' }),
  item(mauCorte, { name: 'Corte', parent_id: mauricio }),
  item(mauBarba, { name: 'Barba', parent_id: mauricio }),
  item(anyParent, {
    name: 'Reserva con cualquier barbero',
    redeem_assignment_mode: 'round_robin',
    digital_subtype: 'pass',
    kind: 'digital_asset',
  }),
  item(anyCorte, { name: 'Corte', parent_id: anyParent, redeem_assignment_mode: 'round_robin' }),
  item(anyBarba, { name: 'Barba', parent_id: anyParent, redeem_assignment_mode: 'round_robin' }),
];

function mockWorld(opts: {
  reservations?: Array<{ catalog_item_id: string; start_time?: string; end_time?: string }>;
  passRoots?: string[];
} = {}) {
  const reservations = (opts.reservations || []).map((row) => ({
    start_time: start,
    end_time: end,
    quantity: 1,
    status: 'confirmed',
    ...row,
  }));
  const passRoots = opts.passRoots ?? [emmanuel, mauricio];

  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const api: any = {
      select: () => api,
      eq: (col: string, val: string) => {
        api._eq = { ...(api._eq || {}), [col]: val };
        return api;
      },
      in: (col: string, vals: string[]) => {
        api._in = { ...(api._in || {}), [col]: vals };
        return api;
      },
      lt: () => api,
      gt: () => api,
      gte: () => api,
      lte: () => api,
      neq: () => api,
      maybeSingle: async () => {
        if (table === 'catalog_items') {
          return { data: familyItems.find((row) => row.id === api._eq?.id) || null, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => api.maybeSingle(),
      then: (resolve: (value: unknown) => unknown) => {
        if (table === 'catalog_items') {
          if (api._eq?.parent_id) {
            return Promise.resolve(resolve({
              data: familyItems.filter((row) => row.parent_id === api._eq.parent_id),
              error: null,
            }));
          }
          if (api._in?.id) {
            return Promise.resolve(resolve({
              data: familyItems.filter((row) => api._in.id.includes(row.id)),
              error: null,
            }));
          }
          if (api._eq?.site_id) {
            return Promise.resolve(resolve({ data: familyItems, error: null }));
          }
          return Promise.resolve(resolve({ data: [], error: null }));
        }
        if (table === 'reservation_schedules') {
          return Promise.resolve(resolve({
            data: [
              { catalog_item_id: emmanuel, capacity: 1 },
              { catalog_item_id: mauricio, capacity: 1 },
              { catalog_item_id: corte },
              { catalog_item_id: barba },
              { catalog_item_id: mauCorte },
              { catalog_item_id: mauBarba },
            ],
            error: null,
          }));
        }
        if (table === 'reservations') {
          return Promise.resolve(resolve({ data: reservations, error: null }));
        }
        if (table === 'pass_redeemable_items') {
          return Promise.resolve(resolve({
            data: passRoots.map((id) => ({ id: `pri-${id}`, reservable_catalog_item_id: id })),
            error: null,
          }));
        }
        if (table === 'calendar_blocks') {
          return Promise.resolve(resolve({ data: [], error: null }));
        }
        return Promise.resolve(resolve({ data: [], error: null }));
      },
    };
    return api;
  });
}

describe('classifyRoundRobinRole', () => {
  it('keeps named user_choice families as-is', () => {
    expect(classifyRoundRobinRole({
      catalogItemId: corte,
      rootId: emmanuel,
      familyIds: [emmanuel, corte],
      mode: 'user_choice',
      siteId,
    })).toBe('named');
  });

  it('detects the round_robin parent vs sibling', () => {
    expect(classifyRoundRobinRole({
      catalogItemId: anyParent,
      rootId: anyParent,
      familyIds: [anyParent, anyCorte],
      mode: 'round_robin',
      siteId,
    })).toBe('round_robin_parent');
    expect(classifyRoundRobinRole({
      catalogItemId: anyBarba,
      rootId: anyParent,
      familyIds: [anyParent, anyBarba],
      mode: 'round_robin',
      siteId,
    })).toBe('round_robin_sibling');
  });
});

describe('resolveRoundRobinCatalogItem', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does not remap a named barber Corte', async () => {
    mockWorld();
    const result = await resolveRoundRobinCatalogItem({
      catalogItemId: corte,
      start,
      end,
    });
    expect(result).toEqual({
      catalog_item_id: corte,
      assigned_from: corte,
      peer_root_id: emmanuel,
      role: 'named',
    });
  });

  it('assigns a parent pass UUID onto a named barber Corte', async () => {
    mockWorld();
    const result = await resolveRoundRobinCatalogItem({
      catalogItemId: anyParent,
      start,
      end,
    });
    expect(result.role).toBe('round_robin_parent');
    expect(result.assigned_from).toBe(anyParent);
    expect(result.catalog_item_id).toBe(corte);
    expect(result.peer_root_id).toBe(emmanuel);
  });

  it('assigns a round_robin sibling Barba onto a named barber Barba', async () => {
    mockWorld();
    const result = await resolveRoundRobinCatalogItem({
      catalogItemId: anyBarba,
      start,
      end,
    });
    expect(result.role).toBe('round_robin_sibling');
    expect(result.catalog_item_id).toBe(barba);
    expect(result.peer_root_id).toBe(emmanuel);
  });

  it('skips a booked named barber and picks the next free peer', async () => {
    mockWorld({
      reservations: [{ catalog_item_id: corte }],
    });
    const result = await resolveRoundRobinCatalogItem({
      catalogItemId: anyParent,
      start,
      end,
    });
    expect(result.catalog_item_id).toBe(mauCorte);
    expect(result.peer_root_id).toBe(mauricio);
  });

  it('throws when every named barber is booked', async () => {
    mockWorld({
      reservations: [
        { catalog_item_id: corte },
        { catalog_item_id: mauCorte },
      ],
    });
    await expect(resolveRoundRobinCatalogItem({
      catalogItemId: anyParent,
      start,
      end,
    })).rejects.toThrow('Not enough capacity for this slot');
  });

  it('restricts pass assignment to redeemable named barbers', async () => {
    mockWorld({ passRoots: [mauricio] });
    const result = await resolveRoundRobinCatalogItem({
      catalogItemId: anyParent,
      start,
      end,
    });
    expect(result.catalog_item_id).toBe(mauCorte);
    expect(result.peer_root_id).toBe(mauricio);
  });

  it('restricts a pass-family sibling to redeemable named barbers', async () => {
    mockWorld({ passRoots: [mauricio] });
    const result = await resolveRoundRobinCatalogItem({
      catalogItemId: anyBarba,
      start,
      end,
    });
    expect(result.catalog_item_id).toBe(mauBarba);
    expect(result.peer_root_id).toBe(mauricio);
  });
});

describe('pass redemption family match', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('covers a barber child when the pass maps the root', async () => {
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      const api: any = {
        select: () => api,
        eq: () => api,
        in: () => api,
        maybeSingle: async () => ({ data: { id: corte, parent_id: emmanuel }, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(resolve({ data: [{ id: 'pri-1', reservable_catalog_item_id: emmanuel }], error: null })),
      };
      if (table === 'pass_redeemable_items') return api;
      return api;
    });

    await expect(catalogItemCoveredByPass(siteId, anyParent, corte)).resolves.toBe(true);
  });

  it('auto-applies an active lead pass after assignment', async () => {
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      const api: any = {
        select: () => api,
        eq: (col: string, val: string) => {
          api._eq = { ...(api._eq || {}), [col]: val };
          return api;
        },
        in: () => api,
        order: () => api,
        maybeSingle: async () => {
          if (table === 'leads') return { data: { user_id: 'user-1' }, error: null };
          if (table === 'catalog_items') {
            if (api._eq?.id === corte) return { data: { id: corte, parent_id: emmanuel }, error: null };
            return { data: { id: anyParent, digital_subtype: 'pass' }, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (table === 'entitlements') {
            return Promise.resolve(resolve({
              data: [{ id: 'ent-1', status: 'active', uses_remaining: 2, catalog_item_id: anyParent }],
              error: null,
            }));
          }
          if (table === 'pass_redeemable_items') {
            return Promise.resolve(resolve({
              data: [{ id: 'pri-1', reservable_catalog_item_id: emmanuel }],
              error: null,
            }));
          }
          return Promise.resolve(resolve({ data: [], error: null }));
        },
      };
      return api;
    });

    const entitlementId = await resolveReservationEntitlement({
      siteId,
      leadId: 'lead-1',
      quantity: 1,
      catalogItemId: corte,
      originalCatalogItemId: anyParent,
    });
    expect(entitlementId).toBe('ent-1');
  });
});
