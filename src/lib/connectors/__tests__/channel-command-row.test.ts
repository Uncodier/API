import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isAssignedChannelCommand } from '../channel-command-row';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
it('requires raw same-site command and agent columns, never text or matching metadata', async () => {
  const id = randomUUID(), site = randomUUID(), agent = randomUUID();
  const row = { id, site_id: site, agent_id: agent };
  const q: any = { maybeSingle: jest.fn() };
  for (const method of ['select', 'eq', 'abortSignal']) q[method] = jest.fn(() => q);
  jest.mocked(supabaseAdmin.from).mockReturnValue(q);
  for (const data of [null, { ...row, site_id: randomUUID() }, { ...row, agent_id: null, context: `Original Agent ID: ${agent}` }]) {
    q.maybeSingle.mockResolvedValueOnce({ data });
    expect(await isAssignedChannelCommand(id, site, agent)).toBe(false);
  }
  q.maybeSingle.mockResolvedValueOnce({ data: row });
  expect(await isAssignedChannelCommand(id, site, agent)).toBe(true);
  const user = randomUUID();
  q.maybeSingle.mockResolvedValueOnce({ data: { ...row, user_id: randomUUID() } });
  expect(await isAssignedChannelCommand(id, site, agent, user)).toBe(false);
  expect(q.select).toHaveBeenCalledWith('id,site_id,agent_id,user_id');
  expect(q.eq).toHaveBeenCalledWith('user_id', user);
});
