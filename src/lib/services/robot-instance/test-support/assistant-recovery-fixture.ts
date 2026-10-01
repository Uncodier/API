import { jest } from '@jest/globals';
import type { AssistantRecoveryExecution, AssistantRecoveryScope } from '../assistant-recovery-schema';

export const scope: AssistantRecoveryScope = {
  instanceId: 'instance-1', siteId: 'site-1', userId: 'user-1', userMessageLogId: 'action-1',
};
export const execution: AssistantRecoveryExecution = { customTools: [], useSdkTools: false };
type Row = Record<string, any>;
type Filter = { column: string; value: unknown; operator: 'eq' | 'is' | 'in' };
export type Query = { table: string; filters: Filter[]; update?: Row; orders: string[]; columns?: string };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function recoveryDatabase() {
  const tables: Record<string, Row[]> = {
    instance_logs: [{
      id: scope.userMessageLogId, instance_id: scope.instanceId, site_id: scope.siteId,
      user_id: scope.userId, log_type: 'user_action', trusted_user_action: true,
      created_at: '2026-09-30T12:00:00Z', details: { status: 'running', request_id: 'request-1' },
    }],
    instance_nodes: [], instance_node_contexts: [],
  };
  const queries: Query[] = [];
  const database = {
    tables, queries,
    beforeUpdate: undefined as undefined | (() => void),
    afterUpdate: undefined as undefined | (() => void),
    beforeQuery: undefined as undefined | ((query: Query) => void),
    error: undefined as undefined | { message: string },
    throwError: false,
    action: () => tables.instance_logs[0],
    snapshot: () => tables.instance_logs[0].details.assistant_recovery,
    writes: () => queries.filter(query => query.update),
    from: jest.fn((table: string) => {
      const query: Query = { table, filters: [], orders: [] };
      let limit: number | undefined;
      let single = false;
      const chain: any = {};
      chain.select = (columns: string) => { query.columns = columns; return chain; };
      chain.update = (update: Row) => { query.update = update; return chain; };
      for (const operator of ['eq', 'is', 'in'] as const) {
        chain[operator] = (column: string, value: unknown) => {
          query.filters.push({ column, value, operator }); return chain;
        };
      }
      chain.order = (column: string) => { query.orders.push(column); return chain; };
      chain.limit = (value: number) => { limit = value; return chain; };
      chain.maybeSingle = () => { single = true; return chain; };
      chain.then = (resolve: any, reject: any) => Promise.resolve().then(() => {
        queries.push(query);
        database.beforeQuery?.(query);
        if (database.throwError) throw new Error('private database connection URL');
        if (database.error) return { data: null, error: database.error };
        if (query.update) {
          const hook = database.beforeUpdate;
          database.beforeUpdate = undefined;
          hook?.();
        }
        let rows = tables[table].filter(row => query.filters.every(filter => {
          if (filter.operator === 'in') return (filter.value as unknown[]).includes(row[filter.column]);
          if (filter.column === 'details' && typeof filter.value === 'string') {
            return JSON.stringify(row.details) === JSON.stringify(JSON.parse(filter.value));
          }
          const path = filter.column.split(/->>?/);
          const value = path.reduce((current, key) => current?.[key], row);
          if (filter.operator === 'is' && filter.value === null) return value === null || value === undefined;
          return value === filter.value;
        }));
        rows.sort((a, b) => {
          for (const column of query.orders) {
            const difference = String(b[column]).localeCompare(String(a[column]));
            if (difference) return difference;
          }
          return 0;
        });
        if (limit !== undefined) rows = rows.slice(0, limit);
        if (query.update) rows.forEach(row => Object.assign(row, clone(query.update)));
        const result = { data: clone(single ? rows[0] ?? null : rows), error: null };
        if (query.update) {
          const hook = database.afterUpdate;
          database.afterUpdate = undefined;
          hook?.();
        }
        return result;
      }).then(resolve, reject);
      return chain;
    }),
  };
  return database;
}

export function seedRecoveryNodes(database: ReturnType<typeof recoveryDatabase>) {
  database.tables.instance_nodes = [{
    id: 'target-1', instance_id: scope.instanceId, site_id: scope.siteId,
    type: 'prompt', parent_node_id: null, prompt: { text: 'Make an image' },
    result: {}, settings: { model: 'image', ui_position: { x: 1, y: 2 } }, status: 'running',
  }, {
    id: 'context-1', instance_id: scope.instanceId, site_id: scope.siteId,
    type: 'response', parent_node_id: null, prompt: { text: 'Brand details' },
    result: { text: 'Blue brand', outputs: [] }, settings: {}, status: 'completed',
  }];
  database.tables.instance_node_contexts = [{
    target_node_id: 'target-1', context_node_id: 'context-1', type: 'result', site_id: scope.siteId,
  }];
  return { ...execution, instanceNodeId: 'target-1' };
}