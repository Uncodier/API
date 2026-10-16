type Row = Record<string, any>;

/** A small in-memory DB boundary: production template/window/transport code stays real. */
export function whatsappTestDb(tables: Record<string, Row[]>) {
  return (table: string) => {
    if (!tables[table]) throw new Error(`Unexpected table: ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    let inserted: Row[] | undefined;
    let updated: Row | undefined;
    let max = Infinity;
    let sortField: string | undefined;
    let ascending = false;
    const execute = () => {
      if (inserted) tables[table].push(...inserted);
      let rows = tables[table].filter(row => filters.every(filter => filter(row)));
      if (sortField) rows = rows.sort((a, b) => String(a[sortField!]).localeCompare(String(b[sortField!])) * (ascending ? 1 : -1));
      rows = rows.slice(0, max);
      if (updated) rows.forEach(row => Object.assign(row, updated));
      return { data: rows, error: null };
    };
    const query: any = {
      select: jest.fn(() => query),
      eq: jest.fn((field: string, value: unknown) => { filters.push(row => row[field] === value); return query; }),
      order: jest.fn((field: string, options: { ascending?: boolean }) => {
        sortField = field; ascending = options.ascending === true; return query;
      }),
      limit: jest.fn((count: number) => { max = count; return query; }),
      insert: jest.fn((rows: Row[]) => { inserted = rows; return query; }),
      update: jest.fn((row: Row) => { updated = row; return query; }),
      maybeSingle: jest.fn(async () => { const result = execute(); return { ...result, data: result.data[0] ?? null }; }),
      single: jest.fn(async () => { const result = execute(); return { ...result, data: result.data[0] ?? null }; }),
      then: (resolve: (result: unknown) => unknown) => Promise.resolve(execute()).then(resolve),
    };
    return query;
  };
}