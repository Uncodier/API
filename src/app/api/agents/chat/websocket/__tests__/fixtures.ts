export const ids = {
  site: '10000000-0000-4000-8000-000000000001',
  session: '10000000-0000-4000-8000-000000000002',
  visitor: '10000000-0000-4000-8000-000000000003',
  lead: '10000000-0000-4000-8000-000000000004',
  private: '10000000-0000-4000-8000-000000000005',
  anonymous: '10000000-0000-4000-8000-000000000006',
  other: '10000000-0000-4000-8000-000000000007',
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

export function database() {
  const state = {
    apiKeys: [] as any[],
    sites: [] as any[],
    ownership: [] as any[],
    members: [] as any[],
    bearer: `header.${btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`,
    user: { id: 'user-1', role: 'authenticated', is_anonymous: false } as any,
    userExpiresAt: Date.now() + 60_000,
    authError: false,
    session: { id: ids.session, site_id: ids.site, visitor_id: ids.visitor, lead_id: ids.lead as string | null, is_active: true },
    grant: { id: 'grant-1', session_id: ids.session, site_id: ids.site, visitor_id: ids.visitor,
      lead_id: ids.lead, granted_at: '2026-01-01T00:00:00.000Z',
      expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null as string | null },
    epoch: 0,
    failedTable: '',
    historyHook: undefined as undefined | (() => Promise<void> | void),
    resultHook: undefined as undefined | ((table: string) => Promise<void> | void),
    queries: [] as { table: string; filters: [string, unknown][] }[],
    inserts: [] as { table: string; rows: any[] }[],
    conversations: [
      { id: ids.private, site_id: ids.site, visitor_id: ids.visitor, lead_id: ids.lead, status: 'active' },
      { id: ids.anonymous, site_id: ids.site, visitor_id: ids.visitor, lead_id: null, status: 'active' },
    ] as any[],
    channels: [] as any[],
  };
  const db = {
    auth: {
      getUser: jest.fn(async (token: string) => ({
        data: { user: token === state.bearer && !state.authError && state.userExpiresAt > Date.now()
          ? state.user && { ...state.user } : null },
        error: state.authError ? new Error('Auth unavailable') : null,
      })),
    },
    from: jest.fn((table: string) => {
      const filters: [string, unknown][] = [];
      let inserted: any[] | undefined;
      let single = false;
      let limit = 100;
      let expiry = false;
      const execute = async () => {
        state.queries.push({ table, filters: [...filters] });
        if (state.failedTable === table) return { data: null, error: new Error('Database unavailable') };
        let rows: any[];
        if (inserted) {
          state.inserts.push({ table, rows: inserted });
          rows = inserted.map(row => ({ id: ids.other, created_at: new Date().toISOString(), ...row }));
          if (table === 'conversations') state.conversations.push(...rows);
        } else if (table === 'api_keys') rows = state.apiKeys;
        else if (table === 'sites') rows = state.sites;
        else if (table === 'site_ownership') rows = state.ownership;
        else if (table === 'site_members') rows = state.members;
        else if (table === 'visitor_sessions') rows = [state.session];
        else if (table === 'visitor_session_identity_grants') rows = [state.grant];
        else if (table === 'visitor_identity_session_state') rows = [{ session_id: ids.session, epoch: state.epoch }];
        else if (table === 'conversations') rows = state.conversations;
        else if (table === 'messages') {
          rows = [
            { id: 'private-message', conversation_id: ids.private, content: 'OLD ACCOUNT PRIVATE HISTORY', role: 'assistant' },
            { id: 'anonymous-message', conversation_id: ids.anonymous, content: 'Anonymous history', role: 'user' },
          ];
          await state.historyHook?.();
        } else rows = [];
        rows = rows.filter(row => filters.every(([key, value]) => row[key] === value));
        if (expiry) rows = rows.filter(row => !row.expires_at || Date.parse(row.expires_at) > Date.now());
        // Real database results are snapshots, not references to mutable state.
        rows = JSON.parse(JSON.stringify(rows.slice(0, limit)));
        await state.resultHook?.(table);
        return { data: single ? rows[0] || null : rows, error: null };
      };
      const query: any = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        is: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        or: () => { expiry = true; return query; },
        order: () => query,
        limit: (value: number) => { limit = value; return query; },
        maybeSingle: () => { single = true; return query; },
        single: () => { single = true; return query; },
        insert: (rows: any[]) => { inserted = rows; return query; },
        then: (resolve: any, reject: any) => execute().then(resolve, reject),
      };
      return query;
    }),
    channel: jest.fn(() => {
      const channel: any = {
        event: undefined as any,
        status: undefined as any,
        on: jest.fn((_type: string, _options: unknown, callback: any) => { channel.event = callback; return channel; }),
        subscribe: jest.fn((callback: any) => { channel.status = callback; return channel; }),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };
      state.channels.push(channel);
      return channel;
    }),
  };
  const logout = () => { state.session.lead_id = null; state.grant.revoked_at = new Date().toISOString(); state.epoch++; };
  return { db, state, logout };
}