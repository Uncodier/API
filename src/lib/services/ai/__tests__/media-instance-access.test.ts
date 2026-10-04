import { mediaInstanceBelongsToSite } from '../media-instance-access';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));

describe('media instance ownership', () => {
  const siteId = '11111111-1111-4111-8111-111111111111';
  const instanceId = '22222222-2222-4222-8222-222222222222';
  beforeEach(() => jest.clearAllMocks());
  it('allows omitted links and rejects invalid IDs without a lookup', async () => {
    expect(await mediaInstanceBelongsToSite(siteId, undefined)).toBe(true);
    expect(await mediaInstanceBelongsToSite(siteId, 'invalid')).toBe(false);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });
  it.each([
    [{ data: { id: instanceId }, error: null }, true],
    [{ data: null, error: null }, false],
    [{ data: { id: instanceId }, error: { message: 'Unavailable' } }, false],
  ])('checks both site and instance and fails closed on lookup errors', async (result, allowed) => {
    const query: any = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn().mockResolvedValue(result) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
    jest.mocked(supabaseAdmin.from).mockReturnValue(query);
    expect(await mediaInstanceBelongsToSite(siteId, instanceId)).toBe(allowed);
    expect(query.eq.mock.calls).toEqual([['id', instanceId], ['site_id', siteId]]);
  });
});