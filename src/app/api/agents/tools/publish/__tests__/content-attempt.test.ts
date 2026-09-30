import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { DbContent } from '@/lib/database/content-db';

const maybeSingle = jest.fn<() => Promise<{ data: unknown; error: unknown }>>();
const query = {
  update: jest.fn<(...args: unknown[]) => unknown>(),
  eq: jest.fn<(...args: unknown[]) => unknown>(),
  is: jest.fn<(...args: unknown[]) => unknown>(),
  select: jest.fn<(...args: unknown[]) => unknown>(),
  maybeSingle,
};
const from = jest.fn(() => query);
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
let claimSocialContent: typeof import('../content-attempt')['claimSocialContent'];
beforeAll(async () => { ({ claimSocialContent } = await import('../content-attempt')); });

const siteId = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const now = '2026-09-30T03:00:00.000Z';
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  id, site_id: siteId, updated_at: '2026-09-30T02:00:00.123456+00:00', metadata: { existing: 'kept' }, ...overrides,
} as unknown as DbContent);
const fields = () => ({
  text: 'Caption', status: 'draft' as const, published_at: null,
  metadata: { existing: 'kept', social_publication: { attempt_id: 'fresh-attempt', retry_safe: false } },
});

describe('claimSocialContent', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date(now));
    from.mockReturnValue(query);
    query.update.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.is.mockReturnValue(query);
    query.select.mockReturnValue(query);
    maybeSingle.mockResolvedValue({ data: { id, status: 'draft' }, error: null });
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('claims one scoped snapshot atomically using ID, site, timestamp, and complete metadata', async () => {
    const existing = snapshot();
    const input = fields();
    await expect(claimSocialContent(existing, siteId, input)).resolves.toEqual({ id, status: 'draft' });
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('content');
    expect(query.update).toHaveBeenCalledWith({ ...input, updated_at: now });
    expect(query.eq.mock.calls).toEqual([
      ['id', id], ['site_id', siteId], ['updated_at', existing.updated_at], ['metadata', JSON.stringify(existing.metadata)],
    ]);
    expect(query.is).not.toHaveBeenCalled();
    expect(query.select).toHaveBeenCalledWith('id,status');
    expect(maybeSingle).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('compares SQL-null metadata with is rather than equality', async () => {
    await claimSocialContent(snapshot({ metadata: null }), siteId, fields());
    expect(query.is).toHaveBeenCalledWith('metadata', null);
    expect(query.eq.mock.calls.map(([column]) => column)).toEqual(['id', 'site_id', 'updated_at']);
  });

  it('allows published bookkeeping while ignoring non-whitelisted update fields', async () => {
    maybeSingle.mockResolvedValue({ data: { id, status: 'published', secret: 'not-returned' }, error: null });
    const input = { ...fields(), status: 'published' as const, site_id: 'foreign', title: 'ignored' };
    await expect(claimSocialContent(snapshot(), siteId, input)).resolves.toEqual({ id, status: 'published' });
    const update = query.update.mock.calls[0][0];
    expect(update).not.toHaveProperty('site_id');
    expect(update).not.toHaveProperty('title');
  });

  it.each([
    { site_id: '00000000-0000-4000-8000-000000000003' }, { site_id: '' }, { id: 'not-a-uuid' },
    { id: undefined }, { updated_at: '' }, { updated_at: 'yesterday' }, { updated_at: undefined },
    { metadata: undefined }, { metadata: [] }, { metadata: 'not an object' },
  ])('rejects untrusted or malformed snapshots before accessing the service client: %j', async (overrides) => {
    await expect(claimSocialContent(snapshot(overrides), siteId, fields())).rejects.toThrow('could not be claimed');
    expect(from).not.toHaveBeenCalled();
  });

  it.each(['', 'not-a-uuid', '00000000-0000-4000-8000-000000000003'])('requires the authorized snapshot site: %s', async (site) => {
    await expect(claimSocialContent(snapshot(), site, fields())).rejects.toThrow('could not be claimed');
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'archived' }, { text: 7 }, { published_at: 'invalid' }, { metadata: null },
    { metadata: {} }, { metadata: { social_publication: { attempt_id: '' } } },
  ])('validates claim fields before database access: %j', async (overrides) => {
    await expect(claimSocialContent(snapshot(), siteId, { ...fields(), ...overrides } as Parameters<typeof claimSocialContent>[2]))
      .rejects.toThrow('could not be claimed');
    expect(from).not.toHaveBeenCalled();
  });

  it('requires a fresh attempt ID to protect against same-timestamp collisions', async () => {
    await expect(claimSocialContent(snapshot({ metadata: fields().metadata }), siteId, fields())).rejects.toThrow('could not be claimed');
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects unserializable snapshot and update metadata before client access', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(claimSocialContent(snapshot({ metadata: circular }), siteId, fields())).rejects.toThrow('could not be claimed');
    await expect(claimSocialContent(snapshot(), siteId, { ...fields(), metadata: { ...fields().metadata, circular } }))
      .rejects.toThrow('could not be claimed');
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects zero updated rows as a concurrent claim conflict', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(claimSocialContent(snapshot(), siteId, fields())).rejects.toThrow('Refresh its status before retrying');
  });

  it('has only one successful claimant when the mocked CAS returns a conflict for the other', async () => {
    maybeSingle.mockResolvedValueOnce({ data: { id, status: 'draft' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const outcomes = await Promise.allSettled([
      claimSocialContent(snapshot({ updated_at: now }), siteId, fields()),
      claimSocialContent(snapshot({ updated_at: now }), siteId, {
        ...fields(), metadata: { social_publication: { attempt_id: 'another-attempt', retry_safe: false } },
      }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(query.eq.mock.calls.filter(([column]) => column === 'metadata')).toHaveLength(2);
  });

  it.each([
    { data: null, error: { message: 'sensitive database detail' } },
    { data: { id, status: 'draft' }, error: { message: 'sensitive partial failure' } },
    { data: { id: 'wrong', status: 'draft' }, error: null },
    { data: { id, status: 'wrong' }, error: null },
  ])('does not return database failures or malformed data as a successful claim: %j', async (response) => {
    maybeSingle.mockResolvedValue(response);
    const result = claimSocialContent(snapshot(), siteId, fields());
    await expect(result).rejects.toThrow('could not be claimed');
    await expect(result).rejects.not.toThrow('sensitive');
  });

  it('sanitizes thrown transport and lazy client configuration errors', async () => {
    maybeSingle.mockRejectedValue(new Error('sensitive transport detail'));
    await expect(claimSocialContent(snapshot(), siteId, fields())).rejects.not.toThrow('sensitive');
    from.mockImplementation(() => { throw new Error('sensitive service key detail'); });
    await expect(claimSocialContent(snapshot(), siteId, fields())).rejects.not.toThrow('sensitive');
  });
});