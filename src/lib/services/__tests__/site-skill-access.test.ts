import { jest } from '@jest/globals';

const from = jest.fn();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
const { isSiteSkillManager } = await import('../site-skill-access');

const siteId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

function row(data: any, error: any = null) {
  const query: any = { then: (resolve: (value: any) => any) => Promise.resolve({ data, error }).then(resolve) };
  query.select = jest.fn().mockReturnValue(query);
  query.eq = jest.fn().mockReturnValue(query);
  query.maybeSingle = jest.fn().mockResolvedValue({ data, error });
  return query;
}

beforeEach(() => from.mockReset());

it('allows site owners and active admins, but denies ordinary and inactive members', async () => {
  from.mockReturnValueOnce(row({ id: siteId }));
  await expect(isSiteSkillManager(siteId, userId)).resolves.toBe(true);
  for (const role of ['member', 'admin']) {
    from.mockReturnValueOnce(row(null)).mockReturnValueOnce(row(null))
      .mockReturnValueOnce(row(role === 'admin' ? { role } : { role: 'member' }));
    await expect(isSiteSkillManager(siteId, userId)).resolves.toBe(role === 'admin');
  }
  from.mockReturnValueOnce(row(null)).mockReturnValueOnce(row(null)).mockReturnValueOnce(row(null));
  await expect(isSiteSkillManager(siteId, userId)).resolves.toBe(false);
});

it('fails closed on a database lookup error', async () => {
  from.mockReturnValueOnce(row(null, { message: 'database error' }));
  await expect(isSiteSkillManager(siteId, userId)).rejects.toThrow('Unable to verify site role');
});