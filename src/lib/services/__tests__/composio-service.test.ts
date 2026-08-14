import {
  ComposioService,
  mapComposioAuthConfigToIntegration,
  mapComposioToolkitToApp,
} from '@/lib/services/composio-service';

const githubToolkit = {
  slug: 'github',
  name: 'GitHub',
  auth_schemes: ['OAUTH2'],
  no_auth: false,
  meta: {
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-02-01T00:00:00.000Z',
    description: 'GitHub toolkit',
    logo: 'https://logos.composio.dev/api/github',
    categories: [{ name: 'Developer Tools', slug: 'developer-tools' }],
    tools_count: 12,
    triggers_count: 3,
  },
};

describe('Composio v3 mapping', () => {
  it('maps a toolkit to the apps list shape', () => {
    expect(mapComposioToolkitToApp(githubToolkit)).toEqual({
      id: 'github',
      name: 'GitHub',
      description: 'GitHub toolkit',
      appName: 'GitHub',
      appId: 'github',
      key: 'github',
      slug: 'github',
      enabled: true,
      authScheme: 'OAUTH2',
      auth_schemes: ['OAUTH2'],
      logo: 'https://logos.composio.dev/api/github',
      categories: ['developer-tools'],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-02-01T00:00:00.000Z',
      no_auth: false,
      tools_count: 12,
      triggers_count: 3,
    });
  });

  it('maps an auth config to the integration detail shape', () => {
    expect(
      mapComposioAuthConfigToIntegration({
        id: 'ac_123',
        name: 'GitHub Auth',
        auth_scheme: 'OAUTH2',
        status: 'ENABLED',
        created_at: '2024-01-01T00:00:00.000Z',
        last_updated_at: '2024-02-01T00:00:00.000Z',
        toolkit: { slug: 'github', logo: 'https://logos.composio.dev/api/github' },
      }),
    ).toMatchObject({
      id: 'ac_123',
      appName: 'github',
      appId: 'github',
      enabled: true,
      authScheme: 'OAUTH2',
    });
  });
});

describe('ComposioService', () => {
  const originalApiKey = process.env.COMPOSIO_PROJECT_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.COMPOSIO_PROJECT_API_KEY = 'test-composio-key';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env.COMPOSIO_PROJECT_API_KEY = originalApiKey;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('lists apps from GET /api/v3.1/toolkits', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ items: [githubToolkit], next_cursor: null }),
    });

    const apps = await ComposioService.getIntegrations();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://backend.composio.dev/api/v3.1/toolkits?limit=1000&sort_by=alphabetically',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-api-key': 'test-composio-key' }),
      }),
    );
    expect(apps).toHaveLength(1);
    expect(apps[0].appId).toBe('github');
  });

  it('follows toolkit pagination cursors', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          items: [githubToolkit],
          next_cursor: 'cursor-2',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          items: [{ slug: 'gmail', name: 'Gmail', meta: { description: 'Mail' } }],
          next_cursor: null,
        }),
      });

    const apps = await ComposioService.getIntegrations();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://backend.composio.dev/api/v3.1/toolkits?limit=1000&sort_by=alphabetically&cursor=cursor-2',
      expect.any(Object),
    );
    expect(apps.map((app: { appId: string }) => app.appId)).toEqual(['github', 'gmail']);
  });

  it('surfaces the v1 410 Gone error from Composio', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 410,
      statusText: 'Gone',
      json: async () => ({ error: 'This endpoint is no longer available. Please upgrade to v3 APIs. ' }),
    });

    await expect(ComposioService.getIntegrations()).rejects.toThrow(/410 Gone/);
  });

  it('fetches a toolkit by slug', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => githubToolkit,
    });

    const app = await ComposioService.getIntegrationById('github');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://backend.composio.dev/api/v3.1/toolkits/github',
      expect.any(Object),
    );
    expect(app.appId).toBe('github');
  });

  it('fetches an auth config by ac_ id', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        id: 'ac_123',
        name: 'GitHub Auth',
        auth_scheme: 'OAUTH2',
        status: 'ENABLED',
        toolkit: { slug: 'github' },
      }),
    });

    const integration = await ComposioService.getIntegrationById('ac_123');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://backend.composio.dev/api/v3.1/auth_configs/ac_123',
      expect.any(Object),
    );
    expect(integration.id).toBe('ac_123');
  });
});
