import { loadRequirementMigrationHolds, migrationHoldContext, requirementStepExecutionBlock } from '../requirement-execution-visibility';

const query: Record<string, jest.Mock> = {};
for (const key of ['select', 'eq']) query[key] = jest.fn(() => query);
query.in = jest.fn();
query.maybeSingle = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: () => query } }));

describe('authoritative execution visibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.maybeSingle.mockResolvedValue({ data: { status: 'in-progress' } });
    query.in.mockResolvedValue({ data: [] });
  });
  it('returns the real migration hold even if the requirement appears runnable', async () => {
    query.in.mockResolvedValue({ data: [{ file: 'migrations/0016.sql', state: 'platform_review', reason: 'Budget exhausted', attempts: 5 }] });
    expect(await requirementStepExecutionBlock('req', 'site')).toContain('Budget exhausted');
    expect(query.eq).toHaveBeenCalledWith('site_id', 'site');
  });
  it('blocks status reporting as a resume when the requirement is not runnable', async () => {
    query.maybeSingle.mockResolvedValue({ data: { status: 'blocked' } });
    expect(await requirementStepExecutionBlock('req', 'site')).toContain('cannot resume');
  });
  it('does not block runnable work with no hold', async () => {
    expect(await requirementStepExecutionBlock('req', 'site')).toBeNull();
  });
  it('fails closed on unavailable or missing authoritative state', async () => {
    query.in.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(loadRequirementMigrationHolds('req')).rejects.toThrow('unavailable');
    query.maybeSingle.mockResolvedValue({ data: null });
    await expect(requirementStepExecutionBlock('req', 'site')).rejects.toThrow('unavailable');
  });
  it('explains that holds override history without asserting an assigned reviewer', () => {
    const text = migrationHoldContext([{ file: 'migrations/0016.sql', state: 'platform_review', reason: 'Budget exhausted', attempts: 5, updated_at: '2026-10-01T00:00:00Z' }]);
    expect(text).toContain('overrides historical progress');
    expect(text).toContain('NOT a resume');
    expect(text).toContain('not proof');
    expect(migrationHoldContext([])).toBe('');
    expect(query.select).not.toHaveBeenCalled();
  });
});