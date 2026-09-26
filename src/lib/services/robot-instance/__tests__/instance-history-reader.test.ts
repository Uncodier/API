import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  createInstanceHistoryReader,
  serializeInstanceHistoryLog,
  type InstanceHistoryCursor,
  type InstanceHistoryListResult,
  type InstanceHistoryReadResult,
} from '../instance-history-reader';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: jest.fn(), rpc: jest.fn() },
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(1001);
const INSTANCE = id(1002);
const STAMP = '2026-09-25T12:00:00.123456+00:00';
const read = createInstanceHistoryReader(SITE, INSTANCE);
const makeLog = (n: number, extra: Record<string, unknown> = {}) => ({
  id: id(n), created_at: STAMP, log_type: 'agent_action', tool_name: null,
  site_id: SITE, instance_id: INSTANCE, message: `Message ${n}`,
  tool_args: null, tool_result: null, details: null,
  screenshot_base64: 'NEVER_SELECT_SCREENSHOTS', artifacts: ['NEVER_SELECT_ARTIFACTS'],
  ...extra,
});

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exercise the emitted query against local rows, rather than returning an
// already-filtered canned page. PostgREST treats * as an alias for LIKE %.
function likeRegex(pattern: string) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') source += regexLiteral(pattern[++i]);
    else if (char === '%' || char === '*') source += '.*';
    else if (char === '_') source += '.';
    else source += regexLiteral(char);
  }
  return new RegExp(`^${source}$`, 'is');
}

function mockHistory(rows: Array<Record<string, any>>, failure?: { error?: unknown; rejection?: unknown }) {
  const queries: any[] = [];
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    expect(table).toBe('instance_logs');
    const filters: Array<(row: Record<string, any>) => boolean> = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let columns: string[] = [];
    let limit = Infinity;
    const query: any = {};
    query.select = jest.fn((selection: string) => { columns = selection.split(','); return query; });
    query.eq = jest.fn((column: string, value: unknown) => {
      filters.push(row => row[column] === value); return query;
    });
    query.ilike = jest.fn((column: string, pattern: string) => {
      filters.push(row => typeof row[column] === 'string' && likeRegex(pattern).test(row[column]));
      return query;
    });
    query.filter = jest.fn((column: string, operator: string, value: string) => {
      expect(operator).toBe('imatch');
      filters.push(row => typeof row[column] === 'string' && new RegExp(value, 'is').test(row[column]));
      return query;
    });
    query.or = jest.fn((keyset: string) => {
      const match = keyset.match(/^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/);
      if (!match || match[1] !== match[2]) throw new Error('Malformed keyset');
      filters.push(row => row.created_at < match[1] || (row.created_at === match[1] && row.id < match[3]));
      return query;
    });
    query.order = jest.fn((column: string, options: { ascending: boolean }) => {
      orders.push({ column, ascending: options.ascending }); return query;
    });
    query.limit = jest.fn((value: number) => { limit = value; return query; });
    query.insert = query.update = query.delete = query.upsert = jest.fn(() => { throw new Error('Forbidden write'); });
    const result = (single = false) => {
      if (failure?.rejection) return Promise.reject(failure.rejection);
      if (failure?.error) return Promise.resolve({ data: null, error: failure.error });
      const filtered = rows.filter(row => filters.every(filter => filter(row)));
      filtered.sort((a, b) => {
        for (const { column, ascending } of orders) {
          const comparison = String(a[column]).localeCompare(String(b[column]));
          if (comparison) return ascending ? comparison : -comparison;
        }
        return 0;
      });
      const projected = filtered.slice(0, limit).map(row => Object.fromEntries(columns.map(column => {
        const path = column.match(/^(\w+):details->>(\w+)$/);
        return path ? [path[1], row.details?.[path[2]] == null ? null : String(row.details[path[2]])] : [column, row[column]];
      })));
      return Promise.resolve({ data: single ? projected[0] ?? null : projected, error: null });
    };
    query.maybeSingle = jest.fn(() => result(true));
    query.then = (resolve: any, reject: any) => result().then(resolve, reject);
    queries.push(query);
    return query;
  });
  return queries;
}

beforeEach(() => jest.resetAllMocks());
afterEach(() => expect(supabaseAdmin.rpc).not.toHaveBeenCalled());

describe('instance history listing', () => {
  it('always scopes both identifiers, projects only safe list columns and bounds previews/metadata', async () => {
    const rows = [
      ...Array.from({ length: 22 }, (_, i) => makeLog(i, {
        message: '\n"\\'.repeat(30_000), tool_name: 't'.repeat(20_000), log_type: 'a'.repeat(20_000),
        details: { status: 's'.repeat(20_000), other: 'OMIT_DETAILS' },
      })),
      makeLog(80, { site_id: id(2001), message: 'CROSS_SITE' }),
      makeLog(81, { instance_id: id(2002), message: 'CROSS_INSTANCE' }),
    ];
    const queries = mockHistory(rows);
    const result = await read({ action: 'list', limit: 20 }) as InstanceHistoryListResult;
    expect(result.logs).toHaveLength(20);
    expect(result.logs.map(row => row.id)).toEqual(rows.slice(2, 22).reverse().map(row => row.id));
    for (const log of result.logs) {
      expect(log.preview).toHaveLength(600);
      expect(log.preview_is_partial).toBe(true);
      expect(log.log_type).toHaveLength(100);
      expect(log.tool_name).toHaveLength(200);
      expect(log.status).toHaveLength(100);
      expect(log.streaming).toBe(false);
      expect(Object.keys(log).sort()).toEqual(['created_at', 'id', 'log_type', 'preview', 'preview_is_partial', 'status', 'streaming', 'tool_name']);
    }
    // Even hostile escaped message text cannot return a transcript-sized page.
    expect(JSON.stringify(result).length).toBeLessThan(42_000);
    expect(result).toMatchObject({ has_more: true, next_cursor: { created_at: STAMP, id: id(2) } });
    expect(queries[0].select).toHaveBeenCalledWith('id,created_at,log_type,tool_name,message,status:details->>status,streaming:details->>streaming');
    expect(queries[0].eq.mock.calls).toEqual([['site_id', SITE], ['instance_id', INSTANCE]]);
    expect(queries[0].limit).toHaveBeenCalledWith(21);
    expect(queries[0].insert).not.toHaveBeenCalled();
  });

  it('paginates equal timestamps, microseconds and queued rows without gaps or repeats', async () => {
    const rows = [
      makeLog(1, { created_at: '2026-09-25T12:00:00.123455+00:00' }),
      ...Array.from({ length: 7 }, (_, i) => makeLog(i + 2, {
        log_type: 'user_action', details: { status: 'queued', streaming: true },
      })),
      makeLog(9, { created_at: '2026-09-25T12:00:00.123457+00:00' }),
    ];
    const queries = mockHistory(rows);
    const found: string[] = [];
    let before: InstanceHistoryCursor | undefined;
    for (let i = 0; i < 3; i += 1) {
      const result = await read({ action: 'list', limit: 3, ...(before ? { before } : {}) }) as InstanceHistoryListResult;
      found.push(...result.logs.map(row => row.id));
      for (const row of result.logs.filter(row => row.log_type === 'user_action')) {
        expect(row).toMatchObject({ status: 'queued', streaming: true });
      }
      expect(result.has_more).toBe(i < 2);
      if (i < 2) expect(result.next_cursor).toEqual({ created_at: STAMP, id: id(7 - i * 3) });
      else expect(result.next_cursor).toBeNull();
      before = result.next_cursor ?? undefined;
    }
    expect(found).toEqual(rows.slice().reverse().map(row => row.id));
    expect(queries[0].order.mock.calls).toEqual([
      ['created_at', { ascending: false }], ['id', { ascending: false }],
    ]);
    expect(queries[1].or).toHaveBeenCalledWith(`created_at.lt.${STAMP},and(created_at.eq.${STAMP},id.lt.${id(7)})`);
    expect(queries.every(query => !query.insert.mock.calls.length)).toBe(true);
  });

  it('escapes %, _ and backslashes for literal ilike search and combines type/scope/keyset filters', async () => {
    const literal = '50%_\\done';
    const rows = [
      makeLog(1, { message: `prefix ${literal} suffix`, log_type: 'error' }),
      makeLog(2, { message: '50xxdone', log_type: 'error' }),
      makeLog(3, { message: literal, log_type: 'agent_action' }),
      makeLog(4, { message: literal.toUpperCase(), log_type: 'error' }),
      makeLog(5, { message: literal, log_type: 'error', site_id: id(2001) }),
    ];
    const queries = mockHistory(rows);
    const first = await read({ action: 'list', query: literal, log_type: 'error', limit: 1 }) as InstanceHistoryListResult;
    const second = await read({ action: 'list', query: literal, log_type: 'error', limit: 1, before: first.next_cursor }) as InstanceHistoryListResult;
    expect(first.logs.map(log => log.id)).toEqual([id(4)]);
    expect(second.logs.map(log => log.id)).toEqual([id(1)]);
    expect(second.next_cursor).toBeNull();
    expect(queries[0].ilike).toHaveBeenCalledWith('message', '%50\\%\\_\\\\done%');
    expect(queries[0].eq).toHaveBeenCalledWith('log_type', 'error');
  });

  it('keeps PostgREST star aliases and regex punctuation literal', async () => {
    const literal = 'a*.[x](b)?^$+|{c}\\_%';
    const queries = mockHistory([
      makeLog(1, { message: `prefix ${literal} suffix` }),
      makeLog(2, { message: 'a lots of nonliteral matching text' }),
    ]);
    const result = await read({ action: 'list', query: literal }) as InstanceHistoryListResult;
    expect(result.logs.map(log => log.id)).toEqual([id(1)]);
    expect(queries[0].ilike).not.toHaveBeenCalled();
    expect(queries[0].filter).toHaveBeenCalledWith('message', 'imatch', regexLiteral(literal));
  });

  it('never inserts search syntax into the raw keyset filter', async () => {
    const query = 'x),id.neq.null,(message.eq."secret")';
    const queries = mockHistory([makeLog(1, { message: query })]);
    const result = await read({ action: 'list', query }) as InstanceHistoryListResult;
    expect(result.logs).toHaveLength(1);
    expect(queries[0].or).not.toHaveBeenCalled();
    expect(queries[0].ilike).toHaveBeenCalledWith('message', `%${query}%`);
  });

  it('returns an explicit end for no matches and short previews', async () => {
    mockHistory([makeLog(1), makeLog(2, { message: null })]);
    const result = await read({ action: 'list' }) as InstanceHistoryListResult;
    expect(result).toMatchObject({ has_more: false, next_cursor: null });
    expect(result.logs[0]).toMatchObject({ preview: '', preview_is_partial: false });
    expect(result.logs[1]).toMatchObject({ preview: 'Message 1', preview_is_partial: false });
    await expect(read({ action: 'list', query: 'missing' })).resolves.toEqual({
      action: 'list', logs: [], has_more: false, next_cursor: null,
    });
  });
});

describe('canonical content and bounded reads', () => {
  it('serializes all four fields consistently, including details on non-tool logs and falsy JSON', () => {
    const row = makeLog(1, { message: 'line\n"quoted"', tool_args: false, tool_result: 0, details: { nested: ['tail'] } });
    expect(serializeInstanceHistoryLog(row)).toBe(JSON.stringify({
      message: row.message, tool_args: false, tool_result: 0, details: { nested: ['tail'] },
    }));
    expect(serializeInstanceHistoryLog({})).toBe('{"message":null,"tool_args":null,"tool_result":null,"details":null}');
  });

  it('reconstructs a large log in <=12000-character chunks with direct tail access', async () => {
    const row = makeLog(1, {
      message: 'legacy message '.repeat(4_200),
      tool_args: { command: 'args'.repeat(6_000) },
      tool_result: { result: '\n"\\😀'.repeat(20_000) },
      details: { last: 'TAIL_ONLY_REFERENCE' },
    });
    const canonical = serializeInstanceHistoryLog(row);
    const queries = mockHistory([row]);
    const first = await read({ action: 'read', log_id: row.id, limit: 12_000 }) as InstanceHistoryReadResult;
    expect(first).toMatchObject({ offset: 0, total_chars: canonical.length, is_partial: true, has_more: true, next_offset: 12_000 });
    const chunks = [first.content];
    let offset = first.next_offset;
    while (offset !== null) {
      const part = await read({ action: 'read', log_id: row.id, offset, limit: 12_000 }) as InstanceHistoryReadResult;
      expect(part.content.length).toBeLessThanOrEqual(12_000);
      expect(part.offset).toBe(offset);
      expect(part.total_chars).toBe(canonical.length);
      chunks.push(part.content);
      offset = part.next_offset;
    }
    expect(chunks.join('')).toBe(canonical);
    const tail = await read({ action: 'read', log_id: row.id, offset: canonical.length - 100, limit: 100 }) as InstanceHistoryReadResult;
    expect(tail.content).toBe(canonical.slice(-100));
    expect(tail.content).toContain('TAIL_ONLY_REFERENCE');
    expect(tail).toMatchObject({ is_partial: true, has_more: false, next_offset: null });
    expect(queries.every(query => !query.insert.mock.calls.length)).toBe(true);
    expect(queries[0].select).toHaveBeenCalledWith('id,created_at,log_type,tool_name,message,tool_args,tool_result,details');
    expect(queries[0].eq.mock.calls).toEqual([['site_id', SITE], ['instance_id', INSTANCE], ['id', row.id]]);
    expect(queries[0].maybeSingle).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveProperty('screenshot_base64');
    expect(first).not.toHaveProperty('details');
  });

  it('uses UTF-16 offsets even inside surrogate pairs, without losing characters', async () => {
    const row = makeLog(1, { message: 'a😀b' });
    const canonical = serializeInstanceHistoryLog(row);
    mockHistory([row]);
    const offset = canonical.indexOf('😀');
    const left = await read({ action: 'read', log_id: row.id, offset, limit: 1 }) as InstanceHistoryReadResult;
    const right = await read({ action: 'read', log_id: row.id, offset: left.next_offset, limit: 1 }) as InstanceHistoryReadResult;
    expect(left.content + right.content).toBe('😀');
  });

  it('reports complete reads and empty EOF/beyond-EOF slices consistently', async () => {
    const row = makeLog(1);
    const canonical = serializeInstanceHistoryLog(row);
    mockHistory([row]);
    const full = await read({ action: 'read', log_id: row.id }) as InstanceHistoryReadResult;
    expect(full).toMatchObject({ content: canonical, is_partial: false, has_more: false, next_offset: null });
    for (const offset of [canonical.length, canonical.length + 1, Number.MAX_SAFE_INTEGER]) {
      await expect(read({ action: 'read', log_id: row.id, offset })).resolves.toMatchObject({
        content: '', offset, total_chars: canonical.length, is_partial: true, has_more: false, next_offset: null,
      });
    }
  });

  it('does not distinguish unknown logs from cross-site/cross-instance logs', async () => {
    const queries = mockHistory([
      makeLog(1, { site_id: id(2001) }), makeLog(2, { instance_id: id(2002) }),
    ]);
    for (const log_id of [id(1), id(2), id(3)]) {
      await expect(read({ action: 'read', log_id })).rejects.toThrow('Instance history log not found in the current site and instance.');
    }
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query.eq).toHaveBeenCalledWith('site_id', SITE);
      expect(query.eq).toHaveBeenCalledWith('instance_id', INSTANCE);
    }
  });
});

describe('strict validation and safe errors', () => {
  it.each([
    null, undefined, [], 'list', {}, { action: 'create' },
    { action: 'list', instance_id: INSTANCE }, { action: 'list', site_id: SITE },
    { action: 'read', log_id: id(1), siteId: SITE }, { action: 'list', log_id: id(1) },
    { action: 'list', offset: 0 }, { action: 'read', log_id: id(1), query: 'text' },
    { action: 'list', before: { created_at: STAMP } },
    { action: 'list', before: { id: id(1) } },
    { action: 'list', before: { created_at: STAMP, id: 'not-uuid' } },
    { action: 'list', before: { created_at: STAMP, id: id(1), site_id: SITE } },
    { action: 'list', before: null },
    { action: 'list', before: { created_at: '2026-02-30T00:00:00Z', id: id(1) } },
    { action: 'list', before: { created_at: '2026-09-25', id: id(1) } },
    { action: 'list', before: { created_at: `${STAMP},id.neq.null`, id: id(1) } },
    { action: 'list', before: { created_at: STAMP, id: `${id(1)},site_id.eq.x` } },
    { action: 'list', before: { created_at: '2026-09-25T00:00:00+00:99', id: id(1) } },
    { action: 'list', query: '' }, { action: 'list', query: '   ' },
    { action: 'list', query: 'x'.repeat(201) }, { action: 'list', query: 'x\0y' },
    { action: 'list', log_type: '' }, { action: 'list', log_type: 'x'.repeat(101) },
    { action: 'read' }, { action: 'read', log_id: 'no' },
    ...[0, -1, 21, 1.5, NaN, Infinity, '2', null].map(limit => ({ action: 'list', limit })),
    ...[0, -1, 12_001, 1.5, NaN, Infinity, '2', null].map(limit => ({ action: 'read', log_id: id(1), limit })),
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null].map(offset => ({ action: 'read', log_id: id(1), offset })),
  ])('rejects bad arguments without touching the database: %#', async args => {
    await expect(read(args)).rejects.toThrow(/Invalid instance_history arguments/);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it.each([[null, INSTANCE], [SITE, undefined], ['', INSTANCE], [SITE, 'not-a-uuid']])(
    'fails closed on invalid trusted scope: %#', (site, instance) => {
      expect(() => createInstanceHistoryReader(site as string, instance as string)).toThrow(/trusted siteId and instanceId UUIDs/);
      expect(supabaseAdmin.from).not.toHaveBeenCalled();
    },
  );

  it.each(['list', 'read'])('redacts returned DB errors and thrown network failures for %s', async action => {
    const spies = ['log', 'warn', 'error'].map(method => jest.spyOn(console, method as 'log').mockImplementation(() => {}));
    try {
      const args = action === 'read' ? { action, log_id: id(1) } : { action };
      for (const failure of [
        { error: { message: 'SECRET_PAYLOAD', details: 'PRIVATE_KEY', code: '42501' } },
        { rejection: new Error('SECRET_URL_WITH_KEY') },
      ]) {
        mockHistory([], failure);
        await expect(read(args)).rejects.toThrow(`Unable to ${action} instance history; retry later.`);
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }
  });

  it('redacts unexpected serialization failures without logging the payload', async () => {
    const details: Record<string, unknown> = { secret: 'PRIVATE_PAYLOAD' };
    details.circular = details;
    mockHistory([makeLog(1, { details })]);
    await expect(read({ action: 'read', log_id: id(1) })).rejects.toThrow('Unable to serialize this instance history log.');
  });
});