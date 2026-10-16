type Row = Record<string, any>;

/** In-memory persistence boundary, including tenant joins and JSON CAS filters. */
export function voiceTestDatabase(siteId: string, leadId: string) {
  const tables: Record<string, Row[]> = {
    settings: [{ site_id: siteId, channels: { connections: [
      { id: 'first', type: 'voice', status: 'connected', zavu_sender_id: 'first-sender' },
      { id: 'selected', type: 'voice', status: 'connected', zavu_sender_id: 'selected-sender' },
      { id: 'sms', type: 'sms', status: 'connected', zavu_sender_id: 'sms-sender' },
    ] } }],
    sites: [{ id: siteId, name: 'Test business' }],
    leads: [{ id: leadId, site_id: siteId, name: 'Ada Example', email: 'ada@example.test', phone: '+15551234567',
      do_not_call: false, voice_call_consent_status: 'granted', voice_call_consent_at: '2026-01-01T00:00:00Z' }],
    conversations: [], messages: [], voice_call_deliveries: [],
  };
  const writes: Array<{ table: string; operation: string; rows: Row[] }> = [];
  let failMessageInsert = false;
  let settingsReads = 0;
  let onSettingsRead: ((count: number) => void) | undefined;
  const from = (table: string) => {
    if (!tables[table]) throw new Error(`Unexpected database table: ${table}`);
    let operation = 'select'; let payload: Row[] = []; let single = false;
    const filters: Array<(row: Row) => boolean> = [];
    const value = (row: Row, key: string) => key === 'conversations.site_id'
      ? tables.conversations.find(c => c.id === row.conversation_id)?.site_id : row[key];
    const equal = (left: unknown, right: unknown) => typeof left === 'object' && typeof right === 'string'
      ? JSON.stringify(left) === right : left === right;
    const q: any = {
      select: () => q,
      eq: (key: string, expected: unknown) => { filters.push(row => equal(value(row, key), expected)); return q; },
      neq: (key: string, expected: unknown) => { filters.push(row => !equal(value(row, key), expected)); return q; },
      is: (key: string, expected: unknown) => { filters.push(row => value(row, key) === expected); return q; },
      in: (key: string, expected: unknown[]) => { filters.push(row => expected.includes(value(row, key))); return q; },
      or: () => q,
      not: (key: string, _operator: string, expected: unknown) => {
        filters.push(row => value(row, key) !== expected && value(row, key) !== undefined); return q;
      },
      order: () => q, limit: () => q,
      insert: (rows: Row | Row[]) => { operation = 'insert'; payload = structuredClone(Array.isArray(rows) ? rows : [rows]); return q; },
      update: (row: Row) => { operation = 'update'; payload = [structuredClone(row)]; return q; },
      delete: () => { operation = 'delete'; return q; },
      single: () => { single = true; return q; }, maybeSingle: () => { single = true; return q; },
      then: (resolve: (result: any) => unknown, reject: (error: unknown) => unknown) => {
        try {
          if (table === 'settings' && operation === 'select') onSettingsRead?.(++settingsReads);
          if (table === 'messages' && operation === 'insert' && failMessageInsert) {
            return Promise.resolve({ data: null, error: { message: 'Synthetic insert failure' } }).then(resolve, reject);
          }
          let rows = tables[table].filter(row => filters.every(filter => filter(row)));
          if (operation === 'insert') { tables[table].push(...payload); rows = payload; }
          if (operation === 'update') rows.forEach(row => Object.assign(row, payload[0]));
          if (operation === 'delete') tables[table] = tables[table].filter(row => !rows.includes(row));
          if (operation !== 'select') writes.push({ table, operation, rows: structuredClone(rows) });
          return Promise.resolve({ data: structuredClone(single ? rows[0] || null : rows), error: null }).then(resolve, reject);
        } catch (error) { return Promise.reject(error).then(resolve, reject); }
      },
    };
    return q;
  };
  return { from, tables, writes,
    failMessageInsert: () => { failMessageInsert = true; },
    onSettingsRead: (callback: (count: number) => void) => { onSettingsRead = callback; },
  };
}