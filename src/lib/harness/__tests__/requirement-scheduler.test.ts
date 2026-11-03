const query = {
  select: jest.fn(), not: jest.fn(), in: jest.fn(), or: jest.fn(),
  order: jest.fn(), limit: jest.fn(),
};
const from = jest.fn(() => query);
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
import { dueScheduledRequirements } from '../requirement-scheduler';

beforeEach(() => {
  jest.resetAllMocks();
  from.mockReturnValue(query);
  for (const method of ['select', 'not', 'in', 'or', 'order'] as const) {
    query[method].mockReturnValue(query);
  }
});

it('queries recurring requirements created OR updated since the inclusive fixed cutoff', async () => {
  query.limit.mockResolvedValue({ data: [
    { id: 'legacy-updated', cron: '* * * * *', updated_at: '2026-11-03T20:29:50Z', metadata: {} },
    { id: 'held', cron: '* * * * *', updated_at: '2026-11-03T20:29:50Z', metadata: { execution_hold: true } },
    { id: 'not-due', cron: '* * * * *', updated_at: '2026-11-03T20:31:00Z', metadata: {} },
    { id: 'invalid-cron', cron: 'invalid', updated_at: '2026-11-03T20:29:50Z', metadata: {} },
  ], error: null });
  expect(await dueScheduledRequirements(new Date('2026-11-03T20:31:30Z'))).toEqual(['legacy-updated']);
  expect(from).toHaveBeenCalledWith('requirements');
  expect(query.or).toHaveBeenCalledWith('created_at.gte.2026-09-01T00:00:00Z,updated_at.gte.2026-09-01T00:00:00Z');
  expect(query.in).toHaveBeenCalledWith('status', ['done', 'on-review']);
  expect(query.not).toHaveBeenCalledWith('cron', 'is', null);
  expect(query.limit).toHaveBeenCalledWith(100);
});

it('reports query failure instead of silently skipping scheduled requirements', async () => {
  query.limit.mockResolvedValue({ data: null, error: { message: 'offline query failure' } });
  await expect(dueScheduledRequirements()).rejects.toThrow('Scheduled requirements unavailable');
});