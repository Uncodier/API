import { jest } from '@jest/globals';

const getAppsAdminClient = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule('@/lib/database/apps-supabase', () => ({ getAppsAdminClient }));

describe('Apps PostgREST schema exposure', () => {
  let syncPostgrestSchemas: typeof import('../postgrest-config').syncPostgrestSchemas;
  const previousAppsUrl = process.env.APPS_SUPABASE_URL;
  const previousRepositoryUrl = process.env.REPOSITORY_SUPABASE_URL;
  const previousToken = process.env.SUPABASE_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    ({ syncPostgrestSchemas } = await import('../postgrest-config'));
  });

  afterAll(() => {
    if (previousAppsUrl === undefined) delete process.env.APPS_SUPABASE_URL;
    else process.env.APPS_SUPABASE_URL = previousAppsUrl;
    if (previousRepositoryUrl === undefined) delete process.env.REPOSITORY_SUPABASE_URL;
    else process.env.REPOSITORY_SUPABASE_URL = previousRepositoryUrl;
    if (previousToken === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
    else process.env.SUPABASE_ACCESS_TOKEN = previousToken;
    globalThis.fetch = originalFetch;
  });

  it('targets the Apps project when both Apps and Repository URLs exist', async () => {
    process.env.APPS_SUPABASE_URL = 'https://appsref.supabase.co';
    process.env.REPOSITORY_SUPABASE_URL = 'https://otherref.supabase.co';
    process.env.SUPABASE_ACCESS_TOKEN = 'test-token';
    getAppsAdminClient.mockReturnValue({
      from: () => ({ select: async () => ({ data: [
        { schema: 'app_aaaaaaaabbbb4ccc8dddeeee' },
      ], error: null }) }),
    });
    const fetchMock = jest.fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(syncPostgrestSchemas()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/projects/appsref/postgrest',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});