export const SITE = "11111111-1111-4111-8111-111111111111";
export const OTHER_SITE = "22222222-2222-4222-8222-222222222222";
export const OWNER = "33333333-3333-4333-8333-333333333333";
export const LEAD = "44444444-4444-4444-8444-444444444444";
export const CONVERSATION = "55555555-5555-4555-8555-555555555555";
export const DELIVERY = "66666666-6666-4666-8666-666666666666";
export const MESSAGE = "77777777-7777-4777-8777-777777777777";
export const PHONE = "+13015550100";
export const CALL = "call-1";
export type Row = Record<string, any>;
type Filter = [string, unknown];

function field(row: Row, key: string) {
  const [column, property] = key.split("->>");
  return property ? row[column]?.[property] : row[column];
}

/** Isolated stateful PostgREST double: PK uniqueness and null-only updates are real test behavior. */
export function inboundDatabase(mockFrom: jest.Mock, initial: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    sites: [{ id: SITE, user_id: OWNER, archived_at: null }],
    settings: [{ site_id: SITE, channels: { connections: [{ zavu_sender_id: 'sender-1' }] } }],
    leads: [], conversations: [], messages: [], voice_call_deliveries: [], ...initial,
  };
  const state = {
    tables,
    operations: [] as Array<{ table: string; kind: string; filters: Filter[]; payload?: Row }>,
    failNextTable: "",
    failNextKind: "",
    insertError: null as null | { code: string; message: string },
    beforeInsert: undefined as undefined | ((row: Row) => void),
    beforeUpdate: undefined as undefined | ((table: string) => void),
  };
  mockFrom.mockImplementation((table: string) => {
    if (!tables[table]) throw new Error(`Unexpected test table ${table}`);
    const filters: Filter[] = [];
    const contains: Filter[] = [];
    const excluded: Filter[] = [];
    let pattern: string | undefined;
    let max = Infinity;
    let update: Row | undefined;
    let upsert: Row[] | undefined;
    let finished: { data: Row[] | null; error: { message: string; code?: string } | null } | undefined;
    const run = () => {
      if (finished) return finished;
      const kind = update ? 'update' : upsert ? 'upsert' : 'read';
      state.operations.push({ table, kind, filters: [...filters], payload: update });
      if (state.failNextTable === table && (!state.failNextKind || state.failNextKind === kind)) {
        state.failNextTable = '';
        finished = { data: null, error: { message: 'private database failure' } };
        return finished;
      }
      if (update) state.beforeUpdate?.(table);
      if (upsert) {
        for (const row of upsert) if (!tables[table].some(saved => saved.id === row.id)) tables[table].push(structuredClone(row));
      }
      let rows = tables[table].filter(row => filters.every(([key, value]) => (field(row, key) ?? null) === value));
      rows = rows.filter(row => excluded.every(([key, value]) => (field(row, key) ?? null) !== value));
      rows = rows.filter(row => contains.every(([key, value]) => {
        const expected = value as { connections?: Array<{ zavu_sender_id: string }> };
        return expected.connections?.every(connection => row[key]?.connections?.some((saved: Row) => saved.zavu_sender_id === connection.zavu_sender_id));
      }));
      if (pattern) {
        const regex = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i');
        rows = rows.filter(row => regex.test(row.phone || ''));
      }
      rows = rows.slice(0, max);
      if (update) rows.forEach(row => Object.assign(row, update));
      finished = { data: structuredClone(rows), error: null };
      return finished;
    };
    const q: any = {
      select: () => q,
      contains: (key: string, value: unknown) => { contains.push([key, value]); return q; },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return q; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return q; },
      not: (key: string, _operator: string, value: unknown) => { excluded.push([key, value]); return q; },
      neq: (key: string, value: unknown) => { excluded.push([key, value]); return q; },
      ilike: (_key: string, value: string) => { pattern = value; return q; },
      limit: (value: number) => { max = value; return q; },
      update: (payload: Row) => { update = payload; return q; },
      upsert: (payload: Row | Row[]) => { upsert = Array.isArray(payload) ? payload : [payload]; return q; },
      maybeSingle: async () => {
        const result = run();
        if (result.data && result.data.length > 1) return { data: null, error: { message: 'multiple rows' } };
        return { ...result, data: result.data?.[0] || null };
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      insert: async (row: Row) => {
        state.operations.push({ table, kind: 'insert', filters: [], payload: row });
        state.beforeInsert?.(row);
        if (state.insertError) return { error: state.insertError };
        if (tables[table].some(saved => saved.id === row.id)) return { error: { code: '23505', message: 'duplicate' } };
        tables[table].push(structuredClone(row));
        return { error: null };
      },
    };
    return q;
  });
  return state;
}

export function linkRows(leadId: string | null = null) {
  return {
    leads: [{ id: LEAD, site_id: SITE, phone: PHONE, name: 'Existing', do_not_call: true, voice_call_consent_status: 'denied' }],
    conversations: [{ id: CONVERSATION, site_id: SITE, lead_id: leadId,
      custom_data: { call_direction: 'inbound', provider_call_id: CALL } }],
    voice_call_deliveries: [{ id: DELIVERY, site_id: SITE, conversation_id: CONVERSATION,
      lead_id: leadId, zavu_call_id: CALL, recipient_phone: PHONE }],
    messages: [{ id: MESSAGE, conversation_id: CONVERSATION, lead_id: leadId,
      custom_data: { provider_call_id: CALL }, content: 'Original transcript' }],
  };
}