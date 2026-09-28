import { jest } from '@jest/globals';
import { v5 as uuidv5 } from 'uuid';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

const from = jest.fn<(...args: any[]) => any>();
let allowRequirementPreviewDomain: typeof import('../requirement-tracking-site').allowRequirementPreviewDomain;
let ensureRequirementTrackingSite: typeof import('../requirement-tracking-site').ensureRequirementTrackingSite;

const requirementId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const originSiteId = '00000000-0000-4000-8000-000000000002';
const ownerId = '00000000-0000-4000-8000-000000000001';
const appSiteId = uuidv5(`makinari:requirement-tracking-site:${requirementId}`, uuidv5.URL);

describe('per-requirement application tracking site', () => {
  let appSite: { id: string; user_id: string } | null;
  let insert: jest.Mock<(row: { id: string; user_id: string }) => Promise<{ error: null }>>;
  let upsert: jest.Mock<(...args: any[]) => Promise<{ error: null }>>;
  let siteLookups: string[];

  beforeAll(() => {
    ({ allowRequirementPreviewDomain, ensureRequirementTrackingSite } =
      loadRuntimeModule<typeof import('../requirement-tracking-site')>(
        'src/lib/services/requirement-tracking-site.ts', {
          uuid: { v5: uuidv5 },
          '@/lib/database/supabase-client': { supabaseAdmin: { from } },
        },
      ));
  });
  beforeEach(() => {
    jest.clearAllMocks();
    appSite = null;
    siteLookups = [];
    insert = jest.fn(async (row: { id: string; user_id: string }) => {
      appSite = { id: row.id, user_id: row.user_id };
      return { error: null };
    });
    upsert = jest.fn(async () => ({ error: null }));
    from.mockImplementation((table: string) => {
      if (table === 'requirements') return {
        select: () => ({ eq: (_field: string, id: string) => ({
          maybeSingle: async () => ({
            data: id === requirementId ? { site_id: originSiteId, title: 'Generated app' } : null,
            error: null,
          }),
        }) }),
      };
      if (table === 'sites') return {
        insert,
        select: () => ({ eq: (_field: string, id: string) => ({
          maybeSingle: async () => {
            siteLookups.push(id);
            return { data: id === originSiteId ? { user_id: ownerId } : appSite, error: null };
          },
        }) }),
      };
      if (table === 'allowed_domains') return { upsert };
      throw new Error(`Unexpected table ${table}`);
    });
  });

  it('creates once for the requirement, owned by the ordering site owner, with tracking enabled', async () => {
    expect(await ensureRequirementTrackingSite(requirementId, originSiteId)).toBe(appSiteId);
    expect(await ensureRequirementTrackingSite(requirementId, originSiteId)).toBe(appSiteId);
    expect(siteLookups).toContain(appSiteId);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      id: appSiteId,
      user_id: ownerId,
      name: 'Generated app',
      tracking: { track_visitors: true, track_actions: true, record_screen: false },
    }));
    expect(appSiteId).not.toBe(originSiteId);
  });

  it('never creates a tracking site or whitelists a domain for a different requirement owner', async () => {
    await expect(ensureRequirementTrackingSite(requirementId, 'other-site'))
      .rejects.toThrow('does not belong');
    await expect(allowRequirementPreviewDomain({
      requirementId, originSiteId: 'other-site', previewUrl: 'https://app.example.com',
    })).rejects.toThrow('does not belong');
    expect(insert).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not whitelist previews until the app tracking site exists', async () => {
    await allowRequirementPreviewDomain({
      requirementId, originSiteId, previewUrl: 'https://app.example.com',
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('reuses the site after a concurrent insert without changing its owner', async () => {
    insert.mockImplementation(async (row) => {
      appSite = { id: row.id, user_id: row.user_id };
      return { error: { code: '23505' } } as any;
    });
    expect(await ensureRequirementTrackingSite(requirementId, originSiteId)).toBe(appSiteId);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a concurrent insert owned by someone else', async () => {
    insert.mockImplementation(async (row) => {
      appSite = { id: row.id, user_id: 'somebody-else' };
      return { error: { code: '23505' } } as any;
    });
    await expect(ensureRequirementTrackingSite(requirementId, originSiteId))
      .rejects.toThrow('could not be safely reused');
  });

  it('whitelists only the generated app site and uses the per-site unique key', async () => {
    await ensureRequirementTrackingSite(requirementId, originSiteId);
    await allowRequirementPreviewDomain({
      requirementId, originSiteId, previewUrl: 'https://App.Example.Com/some/path',
    });
    expect(upsert).toHaveBeenCalledWith(
      { site_id: appSiteId, domain: 'app.example.com' },
      { onConflict: 'site_id,domain', ignoreDuplicates: true },
    );
    expect((upsert.mock.calls[0][0] as { site_id: string }).site_id).not.toBe(originSiteId);
  });

  it('registers a preview on the generated app even if the ordering site already has that domain', async () => {
    // A previous cron version registered this domain on the ordering site.
    // The unique key is (site_id, domain), not domain alone.
    const existingDomains = [{ site_id: originSiteId, domain: 'app.example.com' }];
    upsert.mockImplementation(async (row: any, options: any) => {
      expect(options.onConflict).toBe('site_id,domain');
      if (!existingDomains.some((existing) =>
        existing.site_id === row.site_id && existing.domain === row.domain)) {
        existingDomains.push(row);
      }
      return { error: null };
    });

    await ensureRequirementTrackingSite(requirementId, originSiteId);
    await allowRequirementPreviewDomain({
      requirementId, originSiteId, previewUrl: 'https://app.example.com',
    });
    await allowRequirementPreviewDomain({
      requirementId, originSiteId, previewUrl: 'https://app.example.com',
    });

    expect(existingDomains).toEqual([
      { site_id: originSiteId, domain: 'app.example.com' },
      { site_id: appSiteId, domain: 'app.example.com' },
    ]);
  });

  it('rejects an existing site with a different owner and non-HTTPS preview URLs', async () => {
    appSite = { id: appSiteId, user_id: 'somebody-else' };
    await expect(ensureRequirementTrackingSite(requirementId, originSiteId)).rejects.toThrow('different owner');
    await expect(allowRequirementPreviewDomain({
      requirementId, originSiteId, previewUrl: 'https://app.example.com',
    })).rejects.toThrow('different owner');
    appSite = { id: appSiteId, user_id: ownerId };
    await expect(allowRequirementPreviewDomain({
      requirementId, originSiteId, previewUrl: 'http://app.example.com',
    })).rejects.toThrow('HTTPS');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reports database errors when registering a preview instead of silently dropping them', async () => {
    await ensureRequirementTrackingSite(requirementId, originSiteId);
    upsert.mockResolvedValue({ error: { message: 'database unavailable' } } as any);
    await expect(allowRequirementPreviewDomain({
      requirementId, originSiteId, previewUrl: 'https://app.example.com',
    })).rejects.toMatchObject({ message: 'database unavailable' });
  });
});