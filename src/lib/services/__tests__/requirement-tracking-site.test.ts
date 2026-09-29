import { jest } from '@jest/globals';
import { v5 as uuidv5 } from 'uuid';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

const from = jest.fn<(...args: any[]) => any>();
let allowRequirementPreviewDomain: typeof import('../requirement-tracking-site').allowRequirementPreviewDomain;
let ensureRequirementTrackingSite: typeof import('../requirement-tracking-site').ensureRequirementTrackingSite;

const requirementId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const originSiteId = '00000000-0000-4000-8000-000000000002';
const ownerId = '00000000-0000-4000-8000-000000000001';
const legacyAppSiteId = uuidv5(`makinari:requirement-tracking-site:${requirementId}`, uuidv5.URL);

describe('tracking uses the requirement site without provisioning another site', () => {
  let requirements: Map<string, { site_id: string | null; title: string }>;
  let sites: Map<string, { id: string; user_id: string }>;
  let requirementError: { message: string } | null;
  let siteError: { message: string } | null;
  let siteLookups: string[];
  let siteWrite: jest.Mock<(...args: any[]) => Promise<{ error: null }>>;
  let upsert: jest.Mock<(...args: any[]) => Promise<{ error: { message: string } | null }>>;

  beforeAll(() => {
    ({ allowRequirementPreviewDomain, ensureRequirementTrackingSite } =
      loadRuntimeModule<typeof import('../requirement-tracking-site')>(
        'src/lib/services/requirement-tracking-site.ts', {
          '@/lib/database/supabase-client': { supabaseAdmin: { from } },
        },
      ));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    requirements = new Map([[requirementId, { site_id: originSiteId, title: 'Generated app' }]]);
    sites = new Map([[originSiteId, { id: originSiteId, user_id: ownerId }]]);
    requirementError = null;
    siteError = null;
    siteLookups = [];
    siteWrite = jest.fn(async () => ({ error: null }));
    upsert = jest.fn(async () => ({ error: null }));
    from.mockImplementation((table: string) => {
      if (table === 'requirements') return {
        select: () => ({ eq: (_field: string, id: string) => ({
          maybeSingle: async () => ({ data: requirements.get(id) ?? null, error: requirementError }),
        }) }),
      };
      if (table === 'sites') return {
        insert: siteWrite,
        update: siteWrite,
        upsert: siteWrite,
        delete: siteWrite,
        select: () => ({ eq: (_field: string, id: string) => ({
          maybeSingle: async () => {
            siteLookups.push(id);
            return { data: sites.get(id) ?? null, error: siteError };
          },
        }) }),
      };
      if (table === 'allowed_domains') return { upsert };
      throw new Error(`Unexpected table ${table}`);
    });
  });

  afterEach(() => {
    expect(siteWrite).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalledWith('site_members');
    expect(from).not.toHaveBeenCalledWith('site_ownership');
  });

  it('reuses the existing requirement site on every run without changing its tracking settings', async () => {
    expect(await ensureRequirementTrackingSite(requirementId, originSiteId)).toBe(originSiteId);
    expect(await ensureRequirementTrackingSite(requirementId, originSiteId)).toBe(originSiteId);
    expect(siteLookups).toEqual([originSiteId, originSiteId]);
  });

  it('uses the same site for multiple requirements belonging to that site', async () => {
    const secondRequirementId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    requirements.set(secondRequirementId, { site_id: originSiteId, title: 'Another app' });
    expect(await ensureRequirementTrackingSite(requirementId, originSiteId)).toBe(originSiteId);
    expect(await ensureRequirementTrackingSite(secondRequirementId, originSiteId)).toBe(originSiteId);
    expect(siteLookups).toEqual([originSiteId, originSiteId]);
  });

  it('ignores a site left by the old per-app provisioner, even if its owner differs', async () => {
    sites.set(legacyAppSiteId, { id: legacyAppSiteId, user_id: 'another-owner' });
    expect(await ensureRequirementTrackingSite(requirementId, originSiteId)).toBe(originSiteId);
    await allowRequirementPreviewDomain({ requirementId, originSiteId, previewUrl: 'https://app.example.com' });
    expect(siteLookups).not.toContain(legacyAppSiteId);
    expect(upsert).toHaveBeenCalledWith(
      { site_id: originSiteId, domain: 'app.example.com' },
      { onConflict: 'site_id,domain', ignoreDuplicates: true },
    );
  });

  it('rejects another site even when it has the same owner', async () => {
    sites.set('other-site', { id: 'other-site', user_id: ownerId });
    await expect(ensureRequirementTrackingSite(requirementId, 'other-site')).rejects.toThrow('does not belong');
    await expect(allowRequirementPreviewDomain({
      requirementId, originSiteId: 'other-site', previewUrl: 'https://app.example.com',
    })).rejects.toThrow('does not belong');
    expect(siteLookups).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each(['missing', 'null-site', 'empty-site', 'database-error'])('fails closed for %s requirements', async (scenario) => {
    if (scenario === 'missing') requirements.clear();
    if (scenario === 'null-site') requirements.set(requirementId, { site_id: null, title: 'App' });
    if (scenario === 'empty-site') requirements.set(requirementId, { site_id: '', title: 'App' });
    if (scenario === 'database-error') requirementError = { message: 'database unavailable' };
    const expectedSiteId = scenario === 'empty-site' ? '' : originSiteId;
    await expect(ensureRequirementTrackingSite(requirementId, expectedSiteId)).rejects.toThrow();
    await expect(allowRequirementPreviewDomain({
      requirementId, originSiteId: expectedSiteId, previewUrl: 'https://app.example.com',
    })).rejects.toThrow();
    expect(siteLookups).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each(['missing', 'database-error'])('never recreates an unavailable requirement site (%s)', async (scenario) => {
    if (scenario === 'missing') sites.clear();
    else siteError = { message: 'database unavailable' };
    await expect(ensureRequirementTrackingSite(requirementId, originSiteId)).rejects.toThrow();
    await expect(allowRequirementPreviewDomain({
      requirementId, originSiteId, previewUrl: 'https://app.example.com',
    })).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('registers previews directly on the requirement site without an app-specific site or prior injection', async () => {
    await allowRequirementPreviewDomain({
      requirementId, originSiteId, previewUrl: ' https://App.Example.Com/some/path ',
    });
    expect(upsert).toHaveBeenCalledWith(
      { site_id: originSiteId, domain: 'app.example.com' },
      { onConflict: 'site_id,domain', ignoreDuplicates: true },
    );
    expect(siteLookups).toEqual([originSiteId]);
  });

  it('idempotently registers the requirement site even if a legacy app site already has that domain', async () => {
    const existingDomains = [{ site_id: legacyAppSiteId, domain: 'app.example.com' }];
    upsert.mockImplementation(async (row: { site_id: string; domain: string }, options) => {
      expect(options).toEqual({ onConflict: 'site_id,domain', ignoreDuplicates: true });
      if (!existingDomains.some((existing) => existing.site_id === row.site_id && existing.domain === row.domain)) {
        existingDomains.push(row);
      }
      return { error: null };
    });
    await allowRequirementPreviewDomain({ requirementId, originSiteId, previewUrl: 'https://app.example.com' });
    await allowRequirementPreviewDomain({ requirementId, originSiteId, previewUrl: 'https://app.example.com' });
    expect(existingDomains).toEqual([
      { site_id: legacyAppSiteId, domain: 'app.example.com' },
      { site_id: originSiteId, domain: 'app.example.com' },
    ]);
  });

  it.each(['http://app.example.com', 'not a URL'])('rejects an invalid preview URL: %s', async (previewUrl) => {
    await expect(allowRequirementPreviewDomain({ requirementId, originSiteId, previewUrl })).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reports database errors when registering a preview instead of silently dropping them', async () => {
    upsert.mockResolvedValue({ error: { message: 'database unavailable' } });
    await expect(allowRequirementPreviewDomain({
      requirementId, originSiteId, previewUrl: 'https://app.example.com',
    })).rejects.toMatchObject({ message: 'database unavailable' });
  });
});