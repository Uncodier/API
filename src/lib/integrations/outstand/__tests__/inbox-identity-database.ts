import { supabaseAdmin } from '@/lib/database/supabase-client';

// Stateful offline SDK double, including the real lead PK and DM conversation uniqueness.
export function inboxIdentityDatabase() {
  const state = {
    tables: { sites: [{ id: 'site-1', user_id: 'owner-1' }], leads: [], conversations: [] } as Record<string, any[]>,
    operations: [] as any[],
    fail: '',
    before: null as ((operation: any) => void | Promise<void>) | null,
  };
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    if (!state.tables[table]) throw new Error(`Unexpected table: ${table}`);
    const operation: any = { table, action: 'read', filters: [] };
    state.operations.push(operation);
    const run = async (single = false) => {
      await state.before?.(operation);
      if (state.fail === `${table}:${operation.action}`) return { data: null, error: { code: 'offline' } };
      const rows = state.tables[table];
      let result = rows.filter(row => operation.filters.every(([key, value]: [string, any]) => {
        const [column, jsonKey] = key.split('->>');
        const actual = jsonKey ? row[column]?.[jsonKey] : row[column];
        return value === null ? actual == null : typeof actual === 'object'
          ? JSON.stringify(actual) === value : actual === value;
      }));
      if (operation.action === 'insert') {
        const payload = operation.payload;
        if (payload.some((item: any) => rows.some(row => row.id === item.id && item.id
          || table === 'conversations' && row.site_id === item.site_id
          && row.custom_data?.outstand_conversation_id === item.custom_data?.outstand_conversation_id))) {
          return { data: null, error: { code: '23505' } };
        }
        result = payload.map((item: any) => ({ id: `local-${rows.length + 1}`, ...item }));
        rows.push(...result);
      }
      if (operation.action === 'update') result.forEach(row => Object.assign(row, operation.payload));
      if (operation.limit) result = result.slice(0, operation.limit);
      return { data: JSON.parse(JSON.stringify(single ? result[0] || null : result)), error: null };
    };
    const query: any = {
      select: () => query,
      eq: (key: string, value: any) => { operation.filters.push([key, value]); return query; },
      is: (key: string, value: any) => { operation.filters.push([key, value]); return query; },
      filter: (key: string, comparator: string, value: any) => {
        if (comparator !== 'eq') throw new Error('Unsupported comparator');
        operation.filters.push([key, value]); return query;
      },
      limit: (limit: number) => { operation.limit = limit; return query; },
      insert: (payload: any) => { operation.action = 'insert'; operation.payload = payload; return query; },
      update: (payload: any) => { operation.action = 'update'; operation.payload = payload; return query; },
      single: () => run(true),
      maybeSingle: () => run(true),
      then: (resolve: any, reject: any) => run().then(resolve, reject),
    };
    return query;
  });
  return state;
}