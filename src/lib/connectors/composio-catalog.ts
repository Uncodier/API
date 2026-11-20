import { z } from 'zod';
import type { ComposioClient } from './composio-transport';
import { invalidProviderResponse } from './composio-transport';
import { inputValue, opaqueCursor, pageSchema, providerId, providerValue, safeLogo, safeText, scopesSchema, toolkitSlug } from './composio-validation';

// Live v3.1 catalogue categories use id; retain compatibility with slug responses.
// Categories classify discovery only and never grant execution authority.
const categoryIdentifier = z.string().regex(/^[a-z0-9_&-]{1,100}$/);
const categorySchema = z.object({
  slug: categoryIdentifier.optional(), id: categoryIdentifier.optional(), name: safeText(200),
}).refine(category => category.slug !== undefined || category.id !== undefined);
const toolkitSchema = z.object({
  slug: toolkitSlug, name: safeText(200).min(1), type: z.enum(['native', 'custom']),
  toolkit_type: z.enum(['api', 'mcp']).optional(), enabled: z.boolean().optional(),
  auth_schemes: z.array(safeText(50)).max(30).optional(),
  auth_config_details: z.array(z.object({ mode: safeText(50) })).max(30).optional(),
  composio_managed_auth_schemes: z.array(safeText(50)).max(30).optional(),
  composio_managed_auth: z.array(z.object({
    mode: safeText(50), is_default: z.boolean(), scopes: z.object({ available: scopesSchema }),
  })).max(30).optional(),
  meta: z.object({
    description: safeText(12_000), logo: z.string().max(2048),
    categories: z.array(categorySchema).max(50),
    tools_count: z.number().int().nonnegative(), triggers_count: z.number().int().nonnegative(),
    version: safeText(100).min(1),
  }),
});

function normalizeToolkit(toolkit: z.infer<typeof toolkitSchema>) {
  return {
    slug: toolkit.slug, name: toolkit.name, description: toolkit.meta.description,
    logo_url: safeLogo(toolkit.meta.logo), categories: toolkit.meta.categories.map(category => ({
      slug: category.slug ?? category.id!, name: category.name,
    })),
    auth_schemes: [...new Set([...(toolkit.auth_schemes ?? []), ...(toolkit.auth_config_details?.map(item => item.mode) ?? []),
      ...(toolkit.composio_managed_auth_schemes ?? [])])],
    managed_oauth_scopes: toolkit.composio_managed_auth?.find(app => app.is_default && app.mode === 'OAUTH2')?.scopes.available ?? [],
    tools_count: toolkit.meta.tools_count, triggers_count: toolkit.meta.triggers_count,
    version: toolkit.meta.version, type: toolkit.type, toolkit_type: toolkit.toolkit_type || null,
    enabled: toolkit.enabled ?? null,
  };
}

export type ComposioToolkit = ReturnType<typeof normalizeToolkit>;

/** GET /toolkits: metadata only, not an account list or proof of execution readiness. */
export async function listToolkits(client: ComposioClient, options: {
  query?: string; category?: string; cursor?: string; limit?: number;
} = {}) {
  const input = inputValue(z.object({
    query: safeText(200).optional(), category: toolkitSlug.optional(), cursor: opaqueCursor.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(), options);
  const params = new URLSearchParams({ limit: String(input.limit || 50), type: 'native', sort_by: 'usage' });
  if (input.query) params.set('search', input.query);
  if (input.category) params.set('category', input.category);
  if (input.cursor) params.set('cursor', input.cursor);
  const data = providerValue(pageSchema(toolkitSchema, input.limit || 50), await client.request(`/toolkits?${params}`));
  if (data.items.some(item => item.type !== 'native')) invalidProviderResponse();
  return { items: data.items.map(normalizeToolkit), next_cursor: data.next_cursor ?? null, total_items: data.total_items ?? null };
}

/** GET /toolkits/{slug}. Auth fields, credentials, proxy URLs and raw metadata are never returned. */
export async function getToolkit(client: ComposioClient, slug: string): Promise<ComposioToolkit> {
  inputValue(toolkitSlug, slug);
  const data = providerValue(toolkitSchema, await client.request(`/toolkits/${slug}`));
  if (data.slug !== slug || data.type !== 'native') invalidProviderResponse();
  return normalizeToolkit(data);
}

const authConfigSchema = z.object({
  id: providerId, name: safeText(200), toolkit: z.object({ slug: toolkitSlug }),
  auth_scheme: safeText(50).optional(), status: z.enum(['ENABLED', 'DISABLED']),
});

/** GET /auth_configs. Never surface credentials/shared_connection_fields or infer grants from scopes. */
export async function listAuthConfigs(client: ComposioClient, toolkit: string, cursor?: string) {
  inputValue(toolkitSlug, toolkit);
  if (cursor !== undefined) inputValue(opaqueCursor, cursor);
  const params = new URLSearchParams({ toolkit_slug: toolkit, show_disabled: 'false', limit: '100' });
  if (cursor) params.set('cursor', cursor);
  const data = providerValue(pageSchema(authConfigSchema), await client.request(`/auth_configs?${params}`));
  if (data.items.some(item => item.toolkit.slug !== toolkit || item.status !== 'ENABLED')) invalidProviderResponse();
  return {
    items: data.items.map(item => ({
      id: item.id, name: item.name, toolkitSlug: item.toolkit.slug,
      authScheme: item.auth_scheme ?? null, status: item.status,
    })),
    next_cursor: data.next_cursor ?? null, total_items: data.total_items ?? null,
  };
}