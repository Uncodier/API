import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { getTasks, getTaskStats, TaskFilters } from '@/lib/database/task-db';
import { readRedisJson, writeRedisJson } from '@/lib/services/redis-json-cache';
import { getTaskCore } from '../get/core';
import { POST, GET } from '../get/route';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/services/redis-json-cache', () => ({
  readRedisJson: jest.fn(async () => null),
  writeRedisJson: jest.fn(async () => true),
}));

const siteId = randomUUID();
const statuses = ['pending', 'in_progress', 'completed', 'failed', 'canceled', 'active', 'inactive', 'archived'];
type Row = Record<string, any>;
let rows: Row[];
let queries: any[];
let responseCap: number | undefined;

// Exercise the real DB functions: only the Supabase transport/builder is mocked.
// Filters operate on fixtures, and count is computed before range, as in PostgREST.
function builder(table: string) {
  const predicates: Array<(row: Row) => boolean> = [];
  let range: [number, number] | undefined;
  const query: any = {
    table,
    select: jest.fn(() => query),
    eq: jest.fn((field: string, value: unknown) => {
      predicates.push(row => row[field] === value);
      return query;
    }),
    neq: jest.fn((field: string, value: unknown) => {
      predicates.push(row => row[field] != null && row[field] !== value);
      return query;
    }),
    in: jest.fn((field: string, values: unknown[]) => {
      predicates.push(row => values.includes(row[field]));
      return query;
    }),
    order: jest.fn(() => query),
    range: jest.fn((from: number, to: number) => { range = [from, to]; return query; }),
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
      const filtered = (table === 'tasks' ? rows : []).filter(row => predicates.every(test => test(row)));
      const page = range ? filtered.slice(range[0], range[1] + 1) : filtered;
      const data = responseCap && range ? page.slice(0, responseCap) : page;
      return Promise.resolve({ data, count: filtered.length, error: null }).then(resolve, reject);
    },
  };
  queries.push(query);
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  queries = [];
  responseCap = undefined;
  rows = statuses.map(status => ({
    id: randomUUID(), site_id: siteId, title: `Task ${status}`, status,
    stage: 'consideration', priority: 0, type: 'call', scheduled_date: '2000-01-01T00:00:00Z',
  }));
  rows.push({ ...rows[0], id: randomUUID(), site_id: randomUUID() });
  (createClient as jest.Mock).mockReturnValue({ from: jest.fn(builder) });
});
afterEach(() => { jest.restoreAllMocks(); });

describe('real task queries and statistics', () => {
  it.each<[string, TaskFilters, string[]]>([
    ['defaults', {}, statuses.filter(status => status !== 'archived')],
    ['neither completed nor archived', { include_completed: false, include_archived: false }, statuses.filter(status => !['completed', 'archived'].includes(status))],
    ['completed only', { include_completed: true, include_archived: false }, statuses.filter(status => status !== 'archived')],
    ['archived only', { include_completed: false, include_archived: true }, statuses.filter(status => status !== 'completed')],
    ['both', { include_completed: true, include_archived: true }, statuses],
  ])('applies %s to rows, exact count and stats', async (_label, flags, expected) => {
    const filters = { site_id: siteId, ...flags };
    const result = await getTasks(filters);
    const stats = await getTaskStats(filters);
    expect(result.tasks.map(task => task.status)).toEqual(expected);
    expect(result.total).toBe(expected.length);
    expect(result.hasMore).toBe(false);
    expect(stats.total).toBe(expected.length);
    expect(stats.byStatus).toEqual(Object.fromEntries(expected.map(status => [status, 1])));
    expect(stats.byStage).toEqual({ consideration: expected.length });
    for (const query of queries.filter(query => query.table === 'tasks')) {
      expect(query.eq).toHaveBeenCalledWith('site_id', siteId);
      expect(query.neq.mock.calls).toEqual([
        ...(flags.include_completed === false ? [['status', 'completed']] : []),
        ...(flags.include_archived !== true ? [['status', 'archived']] : []),
      ]);
    }
  });

  it('excludes statuses before pagination without paginating statistics', async () => {
    const filters = { site_id: siteId, include_completed: false, limit: 2, offset: 1 };
    const result = await getTasks(filters);
    const stats = await getTaskStats(filters);
    expect(result.tasks.map(task => task.status)).toEqual(['in_progress', 'failed']);
    expect(result).toMatchObject({ total: 6, hasMore: true });
    expect(stats.total).toBe(6);
    const taskQueries = queries.filter(query => query.table === 'tasks');
    expect(taskQueries[0].select).toHaveBeenCalledWith(expect.any(String), { count: 'exact' });
    expect(taskQueries[0].range).toHaveBeenCalledWith(1, 2);
    expect(taskQueries[1].range).not.toHaveBeenCalled();
  });

  it('determines overdue from status, independently of customer journey stage', async () => {
    rows = [
      { ...rows[0], status: 'completed', stage: 'consideration' },
      { ...rows[1], status: 'pending', stage: 'completed' },
    ];
    expect(await getTaskStats({ site_id: siteId })).toMatchObject({ total: 2, overdue: 1 });
    rows = [rows[0]];
    expect(await getTaskStats({ site_id: siteId })).toMatchObject({ total: 1, overdue: 0 });
  });
});

describe('getTaskCore validation and flags', () => {
  it.each(statuses)('accepts status %s and applies it to both queries', async status => {
    const result: any = await getTaskCore({ site_id: siteId, status, include_archived: true });
    expect(result.success).toBe(true);
    expect(result.data.tasks).toHaveLength(1);
    expect(result.data.tasks[0]).toMatchObject({ status, stage: 'consideration' });
    expect(result.data.summary.by_status).toEqual({ [status]: 1 });
    for (const query of queries.filter(query => query.table === 'tasks')) {
      expect(query.eq).toHaveBeenCalledWith('status', status);
    }
  });

  it.each(['done', 'cancelled', 'awareness', ''])('rejects invalid status %s before cache or DB access', async status => {
    await expect(getTaskCore({ site_id: siteId, status })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: ['status'] })]),
    });
    expect(readRedisJson).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'completed', include_completed: false },
    { status: 'archived', include_archived: false },
    { status: 'archived' },
  ])('rejects contradictory status/flags %j before cache or DB access', async filters => {
    await expect(getTaskCore({ site_id: siteId, ...filters })).rejects.toThrow('No se pueden obtener');
    expect(readRedisJson).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(['include_completed', 'include_archived'])('rejects non-boolean %s', async flag => {
    await expect(getTaskCore({ site_id: siteId, [flag]: 'false' })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: [flag] })]),
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('does not interpret a legacy stage named completed as a completed status', async () => {
    rows = [{ ...rows[0], stage: 'completed' }, { ...rows[2], stage: 'completed' }];
    const result: any = await getTaskCore({ site_id: siteId, stage: 'completed', include_completed: false });
    expect(result.data.tasks).toHaveLength(1);
    expect(result.data.tasks[0].status).toBe('pending');
    expect(result.data.summary.total_tasks).toBe(1);
  });

  it('passes default flags to fresh queries without reading or writing cache', async () => {
    const defaults: any = await getTaskCore({ site_id: siteId });
    expect(defaults.data.filters_applied).toMatchObject({ include_completed: true, include_archived: false });
    expect(defaults.data.pagination.total).toBe(7);
    await getTaskCore({ site_id: siteId, include_completed: false });
    await getTaskCore({ site_id: siteId, include_archived: true });
    expect(readRedisJson).not.toHaveBeenCalled();
    expect(writeRedisJson).not.toHaveBeenCalled();
  });

  it('sees a new task and subsequent notes even when Redis contains a cached empty result', async () => {
    (readRedisJson as jest.Mock).mockResolvedValue({ success: true, data: { tasks: [] } });
    rows = [];
    const filters = { site_id: siteId, lead_id: randomUUID(), include_completed: false };
    expect((await getTaskCore(filters)).data.tasks).toHaveLength(0);
    rows.push({ id: randomUUID(), ...filters, title: 'Study results', type: 'support', status: 'pending', notes: 'Original commitment' });
    expect((await getTaskCore(filters)).data.tasks[0].notes).toBe('Original commitment');
    rows[0].notes = 'Original commitment; additional delivery details';
    expect((await getTaskCore(filters)).data.tasks[0].notes).toBe(rows[0].notes);
    expect(readRedisJson).not.toHaveBeenCalled();
    expect(writeRedisJson).not.toHaveBeenCalled();
  });

  it('uses a stable tie-breaker and keeps pagination open when PostgREST returns fewer rows than requested', async () => {
    responseCap = 2;
    const result = await getTasks({ site_id: siteId, limit: 100 });
    expect(result.tasks).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(queries[0].order.mock.calls).toEqual([
      ['created_at', { ascending: false }], ['id', { ascending: false }],
    ]);
  });
});

describe('HTTP get contract', () => {
  it.each<[Record<string, unknown>, number]>([
    [{ status: 'pending' }, 200],
    [{ status: 'completed', include_completed: true }, 200],
    [{ status: 'completed', include_completed: false }, 400],
    [{ status: 'archived' }, 400],
    [{ status: 'unknown' }, 400],
  ])('returns the expected HTTP code for %j', async (filters, status) => {
    const request = new NextRequest('https://api.example.test/api/agents/tools/tasks/get', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site_id: siteId, ...filters }),
    });
    const response = await POST(request);
    expect(response.status).toBe(status);
    expect((await response.json()).success).toBe(status === 200);
  });

  it('documents real statuses separately from legacy statuses and customer journey stages', async () => {
    const description = await (await GET()).json();
    expect(description.task_statuses).toEqual(['pending', 'in_progress', 'completed', 'failed', 'canceled']);
    expect(description.legacy_task_statuses).toEqual(['active', 'inactive', 'archived']);
    expect(description.task_stages).toContain('awareness');
    expect(description.task_stages).not.toContain('completed');
    expect(description.example_response.data.tasks[0]).toMatchObject({ status: 'pending', stage: 'awareness' });
  });
});