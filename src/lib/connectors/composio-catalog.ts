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
const creationFields = z.object({ auth_config_creation: z.object({ required: z.array(z.unknown()).max(100) }) });
const accountFields = z.object({ connected_account_initiation: z.object({ required: z.array(z.unknown()).max(100) }) });
const toolkitSchema = z.object({
  slug: toolkitSlug, name: safeText(200).min(1), type: z.enum(['native', 'custom']),
  toolkit_type: z.enum(['api', 'mcp']).optional(), enabled: z.boolean().optional(),
  auth_schemes: z.array(safeText(50)).max(30).optional(),
  auth_config_details: z.array(z.object({ mode: safeText(50), fields: z.unknown().optional() })).max(30).optional(),
  composio_managed_auth_schemes: z.array(safeText(50)).max(30).optional(),
  composio_managed_auth: z.array(z.object({
    mode: safeText(50), is_default: z.boolean(), managed_app_id: providerId.optional(), scopes: z.object({ available: scopesSchema }),
  })).max(30).optional(),
  meta: z.object({
    description: safeText(12_000), logo: z.string().max(2048),
    categories: z.array(categorySchema).max(50),
    tools_count: z.number().int().nonnegative(), triggers_count: z.number().int().nonnegative(),
    version: safeText(100).min(1),
  }),
});

function normalizeToolkit(toolkit: z.infer<typeof toolkitSchema>) {
  const defaults = toolkit.composio_managed_auth?.filter(app => app.is_default);
  const defaultApp = defaults?.length === 1 ? defaults[0] : null;
  const legacyModes = toolkit.composio_managed_auth_schemes;
  const defaultManagedAuth = defaultApp ? { scheme: defaultApp.mode, appId: defaultApp.managed_app_id ?? null }
    : defaults === undefined && legacyModes?.length === 1 ? { scheme: legacyModes[0], appId: null } : null;
  const methods = toolkit.auth_config_details ?? [];
  const singleMethod = (mode: string) => methods.filter(method => method.mode === mode).length === 1;
  return {
    slug: toolkit.slug, name: toolkit.name, description: toolkit.meta.description,
    logo_url: safeLogo(toolkit.meta.logo), categories: toolkit.meta.categories.map(category => ({
      slug: category.slug ?? category.id!, name: category.name,
    })),
    auth_schemes: [...new Set([...(toolkit.auth_schemes ?? []), ...methods.map(item => item.mode),
      ...(legacyModes ?? []), ...(toolkit.composio_managed_auth?.map(app => app.mode) ?? [])])],
    managed_oauth_scopes: defaultApp?.mode === 'OAUTH2' ? defaultApp.scopes.available : [],
    default_managed_auth: defaultManagedAuth,
    empty_config_schemes: methods.filter(method => {
      const fields = creationFields.safeParse(method.fields);
      return fields.success && fields.data.auth_config_creation.required.length === 0 && singleMethod(method.mode);
    }).map(method => method.mode),
    account_credential_schemes: methods.filter(method => {
      const fields = accountFields.safeParse(method.fields);
      return fields.success && fields.data.connected_account_initiation.required.some(isProviderAccountField) && singleMethod(method.mode);
    }).map(method => method.mode),
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
  type: z.enum(['default', 'custom']).optional(), is_composio_managed: z.boolean().optional(),
  managed_app_id: providerId.nullish(), proxy_config: z.unknown().optional(),
  shared_connection_fields: z.unknown().optional(), shared_credentials: z.unknown().optional(),
  credentials: z.unknown().optional(), expected_input_fields: z.unknown().optional(),
});

const inputField = z.object({ name: safeText(150).min(1), required: z.boolean().optional(), user_visible: z.boolean().optional() });
function isProviderAccountField(value: unknown) {
  const field = inputField.safeParse(value);
  return field.success && field.data.required !== false && field.data.user_visible !== false;
}

function hasInheritedFields(value: unknown) {
  return value != null && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0);
}

/** GET /auth_configs. Never surface credentials/shared_connection_fields or infer grants from scopes. */
export async function listAuthConfigs(client: ComposioClient, toolkit: string, cursor?: string, includeDisabled = false) {
  inputValue(toolkitSlug, toolkit);
  if (cursor !== undefined) inputValue(opaqueCursor, cursor);
  const params = new URLSearchParams({ toolkit_slug: toolkit, show_disabled: String(includeDisabled), limit: '100' });
  if (cursor) params.set('cursor', cursor);
  const data = providerValue(pageSchema(authConfigSchema), await client.request(`/auth_configs?${params}`));
  if (data.items.some(item => item.toolkit.slug !== toolkit || (!includeDisabled && item.status !== 'ENABLED'))) invalidProviderResponse();
  return {
    items: data.items.map(item => ({
      id: item.id, name: item.name, toolkitSlug: item.toolkit.slug,
      authScheme: item.auth_scheme ?? null, status: item.status,
      isManaged: item.is_composio_managed ?? item.type === 'default', managedAppId: item.managed_app_id ?? null,
      hasSharedFields: hasInheritedFields(item.shared_connection_fields) || hasInheritedFields(item.shared_credentials),
      hasProxy: item.proxy_config != null, hasConfigCredentials: hasInheritedFields(item.credentials),
      // Only an omitted override permits toolkit fallback.
      hasRequiredAccountFields: item.expected_input_fields === undefined ? null : Array.isArray(item.expected_input_fields) && item.expected_input_fields.some(isProviderAccountField),
    })),
    next_cursor: data.next_cursor ?? null, total_items: data.total_items ?? null,
  };
}

export type ComposioAuthConfig = Awaited<ReturnType<typeof listAuthConfigs>>['items'][number];