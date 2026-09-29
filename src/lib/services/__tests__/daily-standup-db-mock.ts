export type QueryLog = { table: string; calls: Array<[string, ...unknown[]]> };

/** Thenable PostgREST double; all reads are local fixtures, all writes fail. */
export function databaseFixture() {
  const queries: QueryLog[] = [];
  const rows: Record<string, any[]> = {};
  const errors: Record<string, unknown> = {};
  const from = jest.fn((table: string) => {
    const log: QueryLog = { table, calls: [] };
    queries.push(log);
    const query: any = {};
    for (const method of ['select', 'eq', 'gte', 'lt', 'order', 'limit', 'in']) {
      query[method] = jest.fn((...args: unknown[]) => {
        log.calls.push([method, ...args]);
        return query;
      });
    }
    query.single = jest.fn(() => {
      log.calls.push(['single']);
      return Promise.resolve({ data: rows[table]?.[0] || null, error: errors[table] || null });
    });
    query.then = (resolve: any, reject: any) => Promise.resolve({
      data: rows[table] || [], error: errors[table] || null,
    }).then(resolve, reject);
    return query;
  });
  return { from, queries, rows, errors };
}