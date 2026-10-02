export type Row = Record<string, any>;

/** Stateful offline SDK double: enforces primary keys, scoped filters and CAS writes. */
export function database() {
  const tables: Record<string, Row[]> = { conversations: [], messages: [], sites: [], content: [] };
  let failure: string | undefined;
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let operation = 'select'; let payload: any; let max = Infinity; let single = false;
    const query: any = {
      select: () => query,
      eq: (key: string, value: any) => {
        filters.push(row => {
          const current = key.includes('->>') ? row[key.split('->>')[0]]?.[key.split('->>')[1]] : row[key];
          return typeof current === 'object' && typeof value === 'string'
            ? JSON.stringify(current) === value : current === value;
        }); return query;
      },
      is: (key: string, value: any) => { filters.push(row => (row[key] ?? null) === value); return query; },
      limit: (value: number) => { max = value; return query; },
      insert: (value: any) => { operation = 'insert'; payload = value; return query; },
      update: (value: any) => { operation = 'update'; payload = value; return query; },
      maybeSingle: () => { single = true; return query; },
      single: () => { single = true; return query; },
      then: (resolve: any, reject: any) => Promise.resolve().then(() => {
        if (failure === table) { failure = undefined; return { data: null, error: { code: 'DB_FAILURE' } }; }
        let rows = tables[table].filter(row => filters.every(filter => filter(row))).slice(0, max);
        if (operation === 'insert') {
          rows = Array.isArray(payload) ? payload : [payload];
          if (rows.some(row => tables[table].some(stored => row.id && stored.id === row.id))) {
            return { data: null, error: { code: '23505' } };
          }
          tables[table].push(...structuredClone(rows));
        }
        if (operation === 'update') rows.forEach(row => Object.assign(row, structuredClone(payload)));
        return { data: structuredClone(single ? rows[0] || null : rows), error: null };
      }).then(resolve, reject),
    };
    return query;
  }
  return { tables, from: jest.fn(from), failNext: (table: string) => { failure = table; } };
}