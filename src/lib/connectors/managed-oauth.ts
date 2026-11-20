import { createHash } from 'node:crypto';
import { z } from 'zod';
import { acquireLock, releaseLock } from '@/lib/security/upstash-rest';
import { getToolkit, listAuthConfigs } from './composio-catalog';
import { createComposioClient, invalidProviderResponse, type ComposioClient } from './composio-transport';
import { providerId, providerValue, toolkitSlug } from './composio-validation';
import { managedOAuthPreset } from './managed-oauth-policy';
import { prepareConnectorProvider } from './provider-binding';
import { ConnectorError } from './types';

const createdSchema = z.object({
  toolkit: z.object({ slug: toolkitSlug }),
  auth_config: z.object({ id: providerId.max(150), is_composio_managed: z.literal(true), auth_scheme: z.literal('OAUTH2') }),
});

async function findEnabledConfig(client: ComposioClient, slug: string, scheme: string, id?: string) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 5; page++) {
    const configs = await listAuthConfigs(client, slug, cursor);
    const match = configs.items.find(config => config.authScheme === scheme && config.status === 'ENABLED' && (!id || config.id === id));
    if (match) return match.id;
    if (!configs.next_cursor) return null;
    if (seen.has(configs.next_cursor)) invalidProviderResponse();
    seen.add(configs.next_cursor);
    cursor = configs.next_cursor;
  }
  throw new ConnectorError('AUTH_CONFIG_LIMIT', 'Too many auth configurations to safely provision another.', 422);
}

async function ensureConfig(client: ComposioClient, projectId: string, slug: string, scheme: 'OAUTH2' | 'API_KEY', config: object) {
  // Configurations belong to the Composio project, not to a single workspace.
  const key = `connectors:oauth-setup:v1:${createHash('sha256').update(projectId).digest('hex')}:${slug}`;
  const existing = await findEnabledConfig(client, slug, scheme);
  if (existing) return existing;
  const lock = await acquireLock(key, 120);
  if (lock.state === 'contended') throw new ConnectorError('AUTH_CONFIG_PENDING', 'OAuth setup may already be in progress. Refresh before retrying.', 409);
  if (lock.state !== 'acquired') throw new ConnectorError('AUTH_CONFIG_SETUP_REQUIRED', 'OAuth setup coordination is unavailable.', 503);

  let writeUnconfirmed = false;
  try {
    const current = await findEnabledConfig(client, slug, scheme);
    if (current) return current;
    writeUnconfirmed = true;
    const payload = await client.request('/auth_configs', { method: 'POST', body: {
      toolkit: { slug },
      auth_config: config,
    } });
    const created = scheme === 'OAUTH2' ? providerValue(createdSchema, payload, true)
      : providerValue(createdSchema.extend({
        auth_config: z.object({ id: providerId.max(150), is_composio_managed: z.literal(false), auth_scheme: z.literal('API_KEY') }),
      }), payload, true);
    if (created.toolkit.slug !== slug || created.auth_config.auth_scheme !== scheme) invalidProviderResponse(true);
    // Confirm visibility under the same project before allowing another writer.
    const visible = await findEnabledConfig(client, slug, scheme, created.auth_config.id).catch(() => invalidProviderResponse(true));
    if (!visible) invalidProviderResponse(true);
    writeUnconfirmed = false;
    return visible;
  } finally {
    if (!writeUnconfirmed) await releaseLock(key, lock.token);
  }
}

export async function createManagedOAuth(siteId: string, userId: string, slug: string) {
  if (slug !== 'googlecalendar') throw new ConnectorError('MANAGED_OAUTH_UNAVAILABLE', 'Self-service OAuth setup is not available for this connector.', 422);
  const { provider, credential } = await prepareConnectorProvider(siteId, userId);
  const client = createComposioClient(credential.apiKey);
  const preset = managedOAuthPreset(await getToolkit(client, slug));
  if (!preset) throw new ConnectorError('MANAGED_OAUTH_UNAVAILABLE', 'The provider does not advertise the approved OAuth permissions for this connector.', 422);
  await ensureConfig(client, provider.project_id, slug, 'OAUTH2', { type: 'use_composio_managed_auth', name: preset.name, credentials: { scopes: preset.scopes } });
  return { status: 'available' as const };
}

export function ensureSupabaseTokenConfig(client: ComposioClient, projectId: string) {
  return ensureConfig(client, projectId, 'supabase', 'API_KEY', {
    type: 'use_custom_auth', authScheme: 'API_KEY', name: 'Makinari Supabase personal access token', credentials: {},
  });
}