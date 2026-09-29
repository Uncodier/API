import { jest } from '@jest/globals';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

const requirementId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const originSiteId = '00000000-0000-4000-8000-000000000002';
const previewUrl = 'https://generated.example.com/some/path';
const allowRequirementPreviewDomain = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
const createRequirementStatusCore = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
const logInstancePreviewUrlRecorded = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
const update = jest.fn<(...args: any[]) => any>();
const from = jest.fn<(...args: any[]) => any>();
const domainUpsert = jest.fn<(...args: any[]) => Promise<{ error: null }>>(async () => ({ error: null }));

describe('preview domain registration uses the requirement site for tracking', () => {
  let sync: typeof import('../commit/status-sync').syncLatestRequirementStatusWithPreview;
  let patch: typeof import('../commit/status-sync').patchLatestRequirementStatusColumns;
  let existingStatus: boolean;
  let registerPreviewDomain: typeof import('@/lib/services/requirement-tracking-site').allowRequirementPreviewDomain;

  beforeAll(() => {
    ({ allowRequirementPreviewDomain: registerPreviewDomain } =
      loadRuntimeModule<typeof import('@/lib/services/requirement-tracking-site')>(
        'src/lib/services/requirement-tracking-site.ts', {
          '@/lib/database/supabase-client': { supabaseAdmin: { from } },
        },
      ));
    ({ syncLatestRequirementStatusWithPreview: sync, patchLatestRequirementStatusColumns: patch } =
      loadRuntimeModule<typeof import('../commit/status-sync')>(
        'src/app/api/cron/shared/commit/status-sync.ts', {
          '@/lib/database/supabase-client': { supabaseAdmin: { from } },
          '@/lib/tools/requirement-status-core': { createRequirementStatusCore },
          '@/lib/services/cron-audit-log': { logInstancePreviewUrlRecorded },
          '@/lib/services/sandbox-service': { SandboxService: {} },
          '@/lib/services/requirement-git-binding': {
            gitBindingBranchTreeUrl: () => 'https://github.com/owner/apps/tree/feature',
          },
          '@/lib/services/requirement-branch': { branchBelongsToRequirement: () => true },
          '@/lib/services/requirement-tracking-site': { allowRequirementPreviewDomain },
        },
      ));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    allowRequirementPreviewDomain.mockImplementation(registerPreviewDomain);
    existingStatus = true;
    update.mockImplementation(() => ({ eq: async () => ({ error: null }) }));
    from.mockImplementation((table: string) => {
      if (table === 'requirements') return {
        select: () => ({ eq: (_field: string, id: string) => ({
          maybeSingle: async () => ({ data: id === requirementId ? { site_id: originSiteId } : null, error: null }),
        }) }),
      };
      if (table === 'sites') return {
        select: () => ({ eq: (_field: string, id: string) => ({
          maybeSingle: async () => ({ data: id === originSiteId ? { id } : null, error: null }),
        }) }),
      };
      if (table === 'allowed_domains') return { upsert: domainUpsert };
      if (table !== 'requirement_status') throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            order: () => ({ limit: async () => ({
              data: existingStatus
                ? [{ id: 'status-1', preview_url: previewUrl }]
                : [],
              error: null,
            }) }),
          }),
        }),
        update,
      };
    });
  });

  afterEach(() => {
    expect(domainUpsert).toHaveBeenCalledWith(
      { site_id: originSiteId, domain: 'generated.example.com' },
      { onConflict: 'site_id,domain', ignoreDuplicates: true },
    );
    expect(from).not.toHaveBeenCalledWith('site_members');
    expect(from).not.toHaveBeenCalledWith('site_ownership');
  });

  it('uses the requirement site when syncing an existing preview', async () => {
    const result = await sync({
      requirementId,
      siteId: originSiteId,
      branch: 'feature/requirement',
      gitBinding: { kind: 'applications', org: 'owner', repo: 'apps', default_branch: 'main' } as any,
      preview_url_resolved: previewUrl,
      use_resolved_preview_only: true,
    });

    expect(result.updated).toBe(true);
    expect(allowRequirementPreviewDomain).toHaveBeenCalledWith({ requirementId, originSiteId, previewUrl });
    expect(update).toHaveBeenCalledWith(expect.not.objectContaining({ site_id: expect.anything() }));
  });

  it('registers the requirement site even if the preview URL did not change', async () => {
    await expect(patch({
      requirementId, siteId: originSiteId, columns: { preview_url: previewUrl },
    })).resolves.toEqual({ updated: true });

    expect(allowRequirementPreviewDomain).toHaveBeenCalledWith({ requirementId, originSiteId, previewUrl });
    expect(logInstancePreviewUrlRecorded).not.toHaveBeenCalled();
    expect(createRequirementStatusCore).not.toHaveBeenCalled();
  });

  it('uses the requirement site for both newly inserted statuses and preview origins', async () => {
    existingStatus = false;
    await expect(patch({
      requirementId, siteId: originSiteId, columns: { preview_url: previewUrl },
    })).resolves.toEqual({ updated: true, created: true });

    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({
      site_id: originSiteId,
      requirement_id: requirementId,
    }));
    expect(allowRequirementPreviewDomain).toHaveBeenCalledWith({ requirementId, originSiteId, previewUrl });
  });
});