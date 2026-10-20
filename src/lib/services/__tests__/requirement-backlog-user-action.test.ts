import { randomUUID } from 'node:crypto';
import { hasUserRequestedMoreWork } from '../requirement-backlog-user-action';
import { supabaseAdmin } from '@/lib/database/supabase-server';

jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));

const requirementId = randomUUID();
const single = jest.fn();
const query: any = {};
for (const method of ['select', 'eq']) query[method] = jest.fn(() => query);
query.single = single;

beforeEach(() => {
  jest.clearAllMocks();
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  single.mockResolvedValue({ data: { backlog: { items: [{ tier: 'core', updated_at: '2026-06-06T10:00:00Z' }] } } });
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: true });
});

it('uses requirement-scoped database admission, not same-runner messages', async () => {
  expect(await hasUserRequestedMoreWork(requirementId)).toBe(true);
  expect(supabaseAdmin.rpc).toHaveBeenCalledWith('has_requirement_scope_authorization', {
    p_requirement_id: requirementId, p_completed_at: '2026-06-06T10:00:00.000Z',
  });
  expect(supabaseAdmin.from).not.toHaveBeenCalledWith('instance_logs');
  expect(query.eq).not.toHaveBeenCalledWith('instance_id', expect.anything());
});

it('ignores ornamental completion when core items exist', async () => {
  single.mockResolvedValue({ data: { backlog: { items: [
    { tier: 'core', updated_at: '2026-06-06T10:00:00Z' },
    { tier: 'ornamental', updated_at: '2026-06-06T12:00:00Z' },
  ] } } });
  expect(await hasUserRequestedMoreWork(requirementId)).toBe(true);
  expect((supabaseAdmin.rpc as jest.Mock).mock.calls[0][1].p_completed_at).toBe('2026-06-06T10:00:00.000Z');
});

it('uses all items if there are no core items and treats missing tier as core', async () => {
  single.mockResolvedValue({ data: { backlog: { items: [{ tier: 'ornamental', updated_at: '2026-06-06T12:00:00Z' }] } } });
  await hasUserRequestedMoreWork(requirementId);
  expect((supabaseAdmin.rpc as jest.Mock).mock.calls[0][1].p_completed_at).toBe('2026-06-06T12:00:00.000Z');
  single.mockResolvedValue({ data: { backlog: { items: [{ updated_at: '2026-06-06T10:00:00Z' }] } } });
  await hasUserRequestedMoreWork(requirementId);
  expect((supabaseAdmin.rpc as jest.Mock).mock.calls[1][1].p_completed_at).toBe('2026-06-06T10:00:00.000Z');
});

it.each([
  { data: null }, { data: { backlog: { items: [] } }, error: { message: 'Unavailable' } },
  { data: { backlog: { items: [{ updated_at: 'invalid' }] } } },
])('fails closed on missing, errored or malformed requirement data', async response => {
  single.mockResolvedValue(response);
  expect(await hasUserRequestedMoreWork(requirementId)).toBe(false);
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
});

it.each([{ data: false }, { data: null }, { data: 'true' }, { data: true, error: { message: 'Unavailable' } }])(
  'does not substitute queued receipt presence for confirmed scope authorization', async response => {
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue(response);
    expect(await hasUserRequestedMoreWork(requirementId)).toBe(false);
  },
);

it('empty backlog uses the epoch watermark', async () => {
  single.mockResolvedValue({ data: { backlog: { items: [] } } });
  await hasUserRequestedMoreWork(requirementId);
  expect((supabaseAdmin.rpc as jest.Mock).mock.calls[0][1].p_completed_at).toBe('1970-01-01T00:00:00.000Z');
});