import { databaseFixture } from './daily-standup-db-mock';
import { getWrapUpInputs } from '../wrapUpData';
import {
  REPORT_SECTIONS, constrainReportSections, normalizeReportSections, persistedReportSections, getLatestReportSections,
} from '../dailyStandupReportSections';
import { buildWrapUpContext, WRAP_UP_SCOPED_BACKGROUND } from '@/lib/prompts/dailyStandupWrapUpContext';
import { renderReportResults } from '../dailyStandupReportOutput';

let mockDb: ReturnType<typeof databaseFixture>;
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (...args: [string]) => mockDb.from(...args) } }));

beforeEach(() => { mockDb = databaseFixture(); });

describe('selection normalization and persisted contract', () => {
  test('only missing fields default all; known legacy statuses work', () => {
    expect(normalizeReportSections(undefined)).toEqual(REPORT_SECTIONS);
    expect(persistedReportSections({ daily_resume_and_stand_up: { status: 'active' } })).toEqual(REPORT_SECTIONS);
    expect(persistedReportSections({ daily_resume_and_stand_up: 'active' })).toEqual(REPORT_SECTIONS);
  });
  test.each([[], null, '', 'sales', {}, ['unknown'], ['sales', 'unknown'], [1]])('fails closed on explicit %p', value => {
    expect(normalizeReportSections(value)).toEqual([]);
    expect(persistedReportSections({ daily_resume_and_stand_up: { report_sections: value } })).toEqual([]);
  });
  test('canonicalizes/dedupes and prevents request expansion', () => {
    expect(normalizeReportSections(Array(20).fill('tasks'))).toEqual(['tasks']);
    expect(constrainReportSections(['tasks'], ['sales', 'tasks'])).toEqual(['tasks']);
    expect(constrainReportSections(['tasks'], ['orders'])).toEqual([]);
  });
  test('latest settings read is scoped/ordered and errors never become all', async () => {
    mockDb.rows.settings = [{ activities: { daily_resume_and_stand_up: { report_sections: ['orders'] } } }];
    expect(await getLatestReportSections('site')).toEqual(['orders']);
    expect(mockDb.queries[0].calls).toContainEqual(['eq', 'site_id', 'site']);
    expect(mockDb.queries[0].calls).toContainEqual(['order', 'created_at', { ascending: false }]);
    expect(mockDb.queries[0].calls).toContainEqual(['limit', 1]);
    mockDb.errors.settings = { message: 'offline' };
    await expect(getLatestReportSections('site')).rejects.toThrow();
  });
});

describe('actual selected data collection and context', () => {
  test.each([
    ['sales', ['sales', 'leads']], ['tasks', ['tasks']], ['requirements', ['requirements']],
    ['social', ['content', 'content_performance']], ['channels', ['settings']], ['records', ['records']],
    ['orders', ['sale_orders']], ['reservations', ['reservations']], ['inventory', ['inventory_levels']],
  ] as const)('%s reads only its confirmed sources', async (section, expected) => {
    const result = await getWrapUpInputs('site', [section]);
    expect(mockDb.queries.map(query => query.table)).toEqual(expected);
    expect(Object.keys(result.sections)).toEqual([section]);
    for (const query of mockDb.queries) {
      const scope = section === 'reservations' ? 'catalog_items.site_id' : 'site_id';
      expect(query.calls).toContainEqual(['eq', scope, 'site']);
      const select = query.calls.find(call => call[0] === 'select')?.[1] as string;
      expect(select).not.toContain('*');
    }
    if (section === 'social') expect(mockDb.queries[0].calls).toContainEqual(['eq', 'type', 'social_post']);
    if (section === 'reservations') expect(mockDb.queries[0].calls[0][1]).toContain('!inner(site_id)');
    const context = buildWrapUpContext({ siteId: 'site', wrapUpInputs: result });
    expect(context).toContain(`Selected report sections: ${section}`);
    expect(context).not.toContain('CONSOLIDATED ANALYSIS FROM ALL DEPARTMENTS');
    expect(context).not.toContain('WEEKLY RITUAL CADENCE');
  });
  test.each([[], null, ['invalid']])('empty/invalid %p never executes a business query', async sections => {
    expect((await getWrapUpInputs('site', sections)).sections).toEqual({});
    expect(mockDb.from).not.toHaveBeenCalled();
  });
  test('missing selection collects all nine but no memories, commands or generic context', async () => {
    const inputs = await getWrapUpInputs('site');
    expect(Object.keys(inputs.sections).sort()).toEqual([...REPORT_SECTIONS].sort());
    expect(mockDb.queries.map(query => query.table)).not.toEqual(expect.arrayContaining(['agent_memories', 'system_memories', 'commands', 'conversations']));
  });
  test('channel context never includes credentials or unrelated settings', async () => {
    mockDb.rows.settings = [{ channels: { email: { status: 'active', enabled: true, password: 'SECRET' },
      agent_whatsapp: { status: 'synced', access_token: 'SECRET_TOKEN' },
      connections: [{ type: 'instagram', status: 'connected', enabled: true, api_key: 'SECRET_KEY' }],
      social: { notes: 'DISABLED_SOCIAL' } }, activities: { sales: 'DISABLED_SALES' } }];
    const inputs = await getWrapUpInputs('site', ['channels']);
    const context = buildWrapUpContext({ siteId: 'site', wrapUpInputs: inputs });
    expect(context).toContain('"status":"active"');
    expect(context).toContain('"channel":"agent_whatsapp"');
    expect(context).toContain('"channel":"instagram"');
    expect(context).not.toMatch(/SECRET|DISABLED_SOCIAL|DISABLED_SALES/);
  });
  test('a disabled dataset injected in inputs is not serialized', async () => {
    const inputs = await getWrapUpInputs('site', ['tasks']);
    inputs.sections.sales = { sales: { rows: [{ title: 'DISABLED_SALE' }], sampled_count: 1, truncated: false, window: 'now' } };
    expect(buildWrapUpContext({ siteId: 'site', wrapUpInputs: inputs })).not.toContain('DISABLED_SALE');
  });
  test('each excluded section stays absent when every other section is enabled', async () => {
    const sources: Record<string, string[]> = {
      sales: ['sales', 'leads'], tasks: ['tasks'], requirements: ['requirements'],
      social: ['content', 'content_performance'], channels: ['settings'], records: ['records'],
      orders: ['sale_orders'], reservations: ['reservations'], inventory: ['inventory_levels'],
    };
    for (const disabled of REPORT_SECTIONS) {
      mockDb = databaseFixture();
      const selected = REPORT_SECTIONS.filter(section => section !== disabled);
      const inputs = await getWrapUpInputs('site', selected);
      for (const source of sources[disabled]) expect(mockDb.queries.map(query => query.table)).not.toContain(source);
      expect(inputs.sections[disabled]).toBeUndefined();
    }
  });
  test('nonempty confirmed inventory/social/order rows are included without cross-section joins', async () => {
    mockDb.rows.inventory_levels = [{ id: 'stock', quantity: 9, location_id: 'location', catalog_items: { name: 'Widget', sku: 'W1' } }];
    mockDb.rows.content_performance = [{ id: 'performance', likes: 12, comments: 3, fetched_at: '2026-09-29T10:00:00Z' }];
    mockDb.rows.sale_orders = [{ id: 'order', order_number: 'ORD-001', status: 'pending', total: 100, currency: 'USD' }];
    const inputs = await getWrapUpInputs('site', ['inventory', 'social', 'orders']);
    const context = buildWrapUpContext({ siteId: 'site', wrapUpInputs: inputs });
    expect(context).toContain('"quantity":9');
    expect(context).toContain('"likes":12');
    expect(context).toContain('ORD-001');
    const inventoryQuery = mockDb.queries.find(query => query.table === 'inventory_levels');
    expect(inventoryQuery?.calls).toContainEqual(['eq', 'catalog_items.site_id', 'site']);
    expect(mockDb.queries.find(query => query.table === 'sale_orders')?.calls[0][1]).not.toContain('sales(');
  });
  test('truthful bounded counts and source failure instead of fabricated zero', async () => {
    mockDb.rows.tasks = Array.from({ length: 201 }, (_, id) => ({ id }));
    const inputs = await getWrapUpInputs('site', ['tasks']);
    expect(inputs.sections.tasks?.tasks.sampled_count).toBe(200);
    expect(inputs.sections.tasks?.tasks.truncated).toBe(true);
    expect(inputs.sections.tasks?.tasks.rows).toHaveLength(200);
    mockDb.errors.tasks = { message: 'no table' };
    await expect(getWrapUpInputs('site', ['tasks'])).rejects.toThrow();
  });
  test('UTC day window is half-open and inventory/social snapshots are not daily deltas', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-29T12:00:00Z'));
    try {
      const inputs = await getWrapUpInputs('site', ['tasks', 'social', 'inventory']);
      expect(inputs.prevDayRange).toEqual({ start: '2026-09-28T00:00:00.000Z', end: '2026-09-29T00:00:00.000Z' });
      expect(mockDb.queries[0].calls).toContainEqual(['lt', 'created_at', inputs.prevDayRange.end]);
      expect(inputs.sections.inventory?.inventory_levels.window).toContain('not_daily_movements');
      expect(inputs.sections.social?.performance.window).toContain('not_daily_deltas');
    } finally { jest.useRealTimers(); }
  });
});

describe('scoped output', () => {
  test('only accepted section keys reach the report; health/subject/message are never reused', () => {
    const output = renderReportResults([{ sections: { tasks: 'One new task.' }, subject: 'SALES', message: 'SALES', health: { reason: 'SALES' } }], ['tasks']);
    expect(output).toEqual({ subject: 'Daily Standup', message: 'Tasks\nOne new task.', report_sections: ['tasks'] });
    expect(WRAP_UP_SCOPED_BACKGROUND.length).toBeGreaterThan(50);
  });
  test.each([
    [{ message: 'Generic report' }], [{ sections: { sales: 'Disabled', tasks: 'Task' } }],
    [{ sections: {} }], [{ sections: { tasks: '' } }], [{ sections: { tasks: {} } }],
  ].map(results => [results]))('fails closed for nonmatching generated output %p', result => {
    expect(() => renderReportResults(result, ['tasks'])).toThrow();
  });
});