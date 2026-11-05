const rows = new Map<string, any>();
let unavailable = false;
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: () => ({ from: () => {
  const filters: Record<string, any> = {};
  let update: any;
  const q: any = {
    insert: async (row: any) => {
      if (unavailable) return { error: { code: '42P01' } };
      const k = JSON.stringify([row.site_id, row.connection_id, row.origin_message_id]);
      if (rows.has(k)) return { error: { code: '23505' } };
      rows.set(k, { ...row, command_id: null }); return { error: null };
    },
    select: () => q,
    update: (v: any) => { update = v; return q; },
    eq: (k: string, v: any) => { filters[k] = v; return q; },
    is: (k: string, v: any) => { filters[k] = v; return q; },
    single: async () => {
      const row = [...rows.values()].find(r => Object.entries(filters).every(([k, v]) => r[k] === v));
      if (!row) return { error: new Error('missing') };
      if (update) Object.assign(row, update);
      return { data: { ...row }, error: null };
    },
  }; return q;
} }) } }));
import { bindInboundCommand, claimInboundCommand } from '../inbound-command-idempotency';
const key = { siteId: 'site', connectionId: 'connection', originMessageId: 'origin' };
beforeEach(() => { rows.clear(); unavailable = false; });
it('elects one submission owner across concurrent retries and reuses its persisted command', async () => {
  const claims = await Promise.all(Array.from({ length: 10 }, () => claimInboundCommand(key)));
  expect(claims.filter(c => c.state === 'claimed')).toHaveLength(1);
  expect(claims.filter(c => c.state === 'busy')).toHaveLength(9);
  const claim = claims.find(c => c.state === 'claimed')!;
  if (claim.state !== 'claimed') throw new Error('missing owner');
  await bindInboundCommand(key, claim.token, 'command-uuid');
  expect(await claimInboundCommand(key)).toEqual({ state: 'reuse', commandId: 'command-uuid' });
});
it('never reclaims an ambiguous submission and fences foreign owners', async () => {
  await claimInboundCommand(key);
  await expect(bindInboundCommand(key, 'other-token', 'other-command')).rejects.toThrow();
  expect(await claimInboundCommand(key)).toEqual({ state: 'busy' });
});
it('separates site and connection identities', async () => {
  await claimInboundCommand(key);
  expect((await claimInboundCommand({ ...key, siteId: 'other' })).state).toBe('claimed');
  expect((await claimInboundCommand({ ...key, connectionId: 'other' })).state).toBe('claimed');
});
it('fails closed when migration/store is unavailable or identity incomplete', async () => {
  unavailable = true;
  await expect(claimInboundCommand(key)).rejects.toThrow('unavailable');
  await expect(claimInboundCommand({ ...key, connectionId: '' })).rejects.toThrow('Incomplete');
});