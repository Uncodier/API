/**
 * Service to interact with Composio API v3.
 * v1 endpoints (e.g. GET /api/v1/apps) return 410 Gone.
 */

const COMPOSIO_BASE_URL = 'https://backend.composio.dev/api/v3.1';
const TOOLKITS_PAGE_LIMIT = 1000;
const MAX_TOOLKIT_PAGES = 20;

type ComposioCategory = string | { name?: string; slug?: string };

export type ComposioToolkit = {
  slug: string;
  name: string;
  type?: string;
  auth_schemes?: string[];
  no_auth?: boolean;
  meta?: {
    created_at?: string;
    updated_at?: string;
    description?: string;
    logo?: string;
    app_url?: string | null;
    categories?: ComposioCategory[];
    triggers_count?: number;
    tools_count?: number;
    version?: string;
  };
};

export type ComposioAuthConfig = {
  id: string;
  name: string;
  auth_scheme?: string;
  status?: string;
  created_at?: string;
  last_updated_at?: string;
  toolkit?: {
    slug?: string;
    logo?: string;
  };
};

type ToolkitsPage = {
  items?: ComposioToolkit[];
  next_cursor?: string | null;
};

function normalizeCategories(categories: ComposioCategory[] = []): string[] {
  return categories
    .map((category) => {
      if (typeof category === 'string') return category;
      return category.slug || category.name || '';
    })
    .filter(Boolean);
}

export function mapComposioToolkitToApp(toolkit: ComposioToolkit) {
  return {
    id: toolkit.slug,
    name: toolkit.name,
    description: toolkit.meta?.description ?? '',
    appName: toolkit.name,
    appId: toolkit.slug,
    key: toolkit.slug,
    slug: toolkit.slug,
    enabled: true,
    authScheme: toolkit.auth_schemes?.[0] ?? (toolkit.no_auth ? 'no_auth' : null),
    auth_schemes: toolkit.auth_schemes ?? [],
    logo: toolkit.meta?.logo ?? '',
    categories: normalizeCategories(toolkit.meta?.categories),
    createdAt: toolkit.meta?.created_at,
    updatedAt: toolkit.meta?.updated_at,
    no_auth: Boolean(toolkit.no_auth),
    tools_count: toolkit.meta?.tools_count ?? 0,
    triggers_count: toolkit.meta?.triggers_count ?? 0,
  };
}

export function mapComposioAuthConfigToIntegration(authConfig: ComposioAuthConfig) {
  return {
    id: authConfig.id,
    name: authConfig.name,
    description: '',
    appName: authConfig.toolkit?.slug ?? authConfig.name,
    appId: authConfig.toolkit?.slug ?? authConfig.id,
    enabled: authConfig.status !== 'DISABLED',
    authScheme: authConfig.auth_scheme ?? null,
    createdAt: authConfig.created_at,
    updatedAt: authConfig.last_updated_at,
    connections: [],
    logo: authConfig.toolkit?.logo ?? '',
    toolkit: authConfig.toolkit,
  };
}

export class ComposioService {
  private static baseUrl = COMPOSIO_BASE_URL;

  private static get apiKey() {
    return process.env.COMPOSIO_PROJECT_API_KEY || '';
  }

  static hasValidApiKey() {
    return !!this.apiKey;
  }

  private static requestHeaders() {
    return {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  private static assertApiKey() {
    if (!this.hasValidApiKey()) {
      console.error('[ComposioService] API key is missing. Please check your environment variables.');
      throw new Error('Composio API key is not configured.');
    }
  }

  private static async parseErrorBody(response: Response) {
    return response.json().catch(() => {
      console.error('[ComposioService] Failed to parse error response as JSON');
      return null;
    });
  }

  private static async requestJson<T>(url: string, label: string): Promise<T> {
    console.log(`[ComposioService] Calling URL: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: this.requestHeaders(),
      cache: 'no-store' as RequestCache,
      next: { revalidate: 0 },
    });

    console.log(`[ComposioService] Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      console.error(`[ComposioService] Error response: ${response.status} ${response.statusText}`);
      const errorData = await this.parseErrorBody(response);
      console.error('[ComposioService] Error data:', errorData);
      throw new Error(
        `Failed to fetch ${label}: ${response.status} ${response.statusText}${
          errorData ? ` - ${JSON.stringify(errorData)}` : ''
        }`,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get all available apps (toolkits) from Composio.
   */
  static async getIntegrations() {
    console.log('[ComposioService] Getting integrations');
    console.log(`[ComposioService] Base URL: ${this.baseUrl}`);
    console.log(`[ComposioService] API Key available: ${!!this.apiKey}`);
    console.log(`[ComposioService] API Key length: ${this.apiKey?.length || 0}`);

    this.assertApiKey();

    try {
      const toolkits: ComposioToolkit[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < MAX_TOOLKIT_PAGES; page += 1) {
        const params = new URLSearchParams({
          limit: String(TOOLKITS_PAGE_LIMIT),
          sort_by: 'alphabetically',
        });
        if (cursor) params.set('cursor', cursor);

        const data = await this.requestJson<ToolkitsPage>(
          `${this.baseUrl}/toolkits?${params.toString()}`,
          'apps',
        );
        toolkits.push(...(data.items ?? []));

        if (!data.next_cursor) break;
        cursor = data.next_cursor;
      }

      const apps = toolkits.map(mapComposioToolkitToApp);
      console.log(`[ComposioService] Successfully fetched ${apps.length} apps`);
      return apps;
    } catch (error) {
      console.error('[ComposioService] Error fetching Composio apps:', error);
      console.error('[ComposioService] Stack trace:', error instanceof Error ? error.stack : 'No stack available');
      throw error;
    }
  }

  /**
   * Get a toolkit by slug or an auth config by id.
   */
  static async getIntegrationById(integrationId: string) {
    console.log(`[ComposioService] Getting integration by ID: ${integrationId}`);
    console.log(`[ComposioService] API Key available: ${!!this.apiKey}`);
    console.log(`[ComposioService] API Key length: ${this.apiKey?.length || 0}`);

    this.assertApiKey();

    try {
      if (integrationId.startsWith('ac_')) {
        const authConfig = await this.requestJson<ComposioAuthConfig>(
          `${this.baseUrl}/auth_configs/${encodeURIComponent(integrationId)}`,
          'integration',
        );
        console.log('[ComposioService] Successfully fetched auth config details');
        return mapComposioAuthConfigToIntegration(authConfig);
      }

      const toolkit = await this.requestJson<ComposioToolkit>(
        `${this.baseUrl}/toolkits/${encodeURIComponent(integrationId)}`,
        'integration',
      );
      console.log('[ComposioService] Successfully fetched toolkit details');
      return mapComposioToolkitToApp(toolkit);
    } catch (error) {
      console.error(`[ComposioService] Error fetching Composio integration ${integrationId}:`, error);
      console.error('[ComposioService] Stack trace:', error instanceof Error ? error.stack : 'No stack available');
      throw error;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ComposioService, mapComposioToolkitToApp, mapComposioAuthConfigToIntegration };
}
