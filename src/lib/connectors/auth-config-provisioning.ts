import { createHash } from 'node:crypto';
import { z } from 'zod';
import { acquireLock, releaseLock } from '@/lib/security/upstash-rest';
import { getToolkit, listAuthConfigs, type ComposioAuthConfig, type ComposioToolkit } from './composio-catalog';
import { invalidProviderResponse, type ComposioClient } from './composio-transport';
import { providerId, providerValue, toolkitSlug } from './composio-validation';
import { ConnectorError } from './types';
import { automaticConnectionPlan, automaticSetupKey, canUseHostedConfig, connectionSetup, existingSetupKey } from './connection-onboarding';

const createdSchema = z.object({
  toolkit: z.object({ slug: toolkitSlug }),
  auth_config: z.object({
    id: providerId.max(150), is_composio_managed: z.boolean(), auth_scheme: z.string(), managed_app_id: providerId.nullish(),
  }),
});

export async function readAuthConfigs(client: ComposioClient, slug: string, includeDisabled = false): Promise<ComposioAuthConfig[]> {
  const items: ComposioAuthConfig[] = [];
  const seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = await listAuthConfigs(client, slug, cursor, includeDisabled);
    for (const config of result.items) {
      if (seen.has(config.id)) invalidProviderResponse();
      seen.add(config.id);
      items.push(config);
    }
    if (!result.next_cursor) return items;
    if (cursors.has(result.next_cursor)) invalidProviderResponse();
    cursors.add(result.next_cursor);
    cursor = result.next_cursor;
  }
  throw new ConnectorError('AUTH_CONFIG_LIMIT', 'Too many auth configurations to safely resolve. Ask your Composio project administrator to review them.', 422);
}

type Provisioning = {
  scheme: string; managed: boolean; appId: string | null; body: object;
  checkConfigs: (configs: ComposioAuthConfig[]) => void;
  canUseCreated: (config: ComposioAuthConfig) => boolean;
  beforeCreate: () => Promise<void>;
};

async function ensureAuthConfig(client: ComposioClient, projectId: string, slug: string, plan: Provisioning) {
  // Same key as the earlier Calendar/Supabase flows: configs belong to the project, not the workspace.
  const key = `connectors:oauth-setup:v1:${createHash('sha256').update(projectId).digest('hex')}:${slug}`;
  const lock = await acquireLock(key, 120);
  if (lock.state === 'contended') throw new ConnectorError('AUTH_CONFIG_PENDING', 'Connection setup is already in progress. Refresh before retrying.', 409);
  if (lock.state !== 'acquired') throw new ConnectorError('AUTH_CONFIG_SETUP_REQUIRED', 'Connection setup coordination is unavailable.', 503);

  let writeUnconfirmed = false;
  try {
    plan.checkConfigs(await readAuthConfigs(client, slug, true));
    await plan.beforeCreate();
    writeUnconfirmed = true;
    let raw: unknown;
    try {
      raw = await client.request('/auth_configs', { method: 'POST', body: { toolkit: { slug }, auth_config: plan.body } });
    } catch (error) {
      if (error instanceof ConnectorError && ['PROVIDER_AUTH_CONFIG_INVALID', 'PROVIDER_AUTH_FAILED', 'PROVIDER_FORBIDDEN', 'PROVIDER_NOT_FOUND', 'PROVIDER_RATE_LIMITED'].includes(error.code)) {
        // An explicit provider rejection did not create a configuration. Do not retry it.
        writeUnconfirmed = false;
      }
      if (error instanceof ConnectorError && ['PROVIDER_FORBIDDEN', 'PROVIDER_AUTH_CONFIG_INVALID'].includes(error.code)) {
        throw new ConnectorError('AUTH_CONFIG_PROVIDER_SETUP_REQUIRED', 'The provider did not allow automatic setup for this project. Ask its administrator to review the configuration and key permissions.', 422);
      }
      if (error instanceof ConnectorError && error.code === 'PROVIDER_REJECTED') invalidProviderResponse(true);
      throw error;
    }
    const created = providerValue(createdSchema, raw, true);
    const config = created.auth_config;
    if (created.toolkit.slug !== slug || config.auth_scheme !== plan.scheme || config.is_composio_managed !== plan.managed ||
      ((config.managed_app_id ?? null) !== plan.appId)) invalidProviderResponse(true);
    const visible = await readAuthConfigs(client, slug, true).catch(() => invalidProviderResponse(true));
    const confirmed = visible.find(item => item.id === config.id && plan.canUseCreated(item));
    if (!confirmed) invalidProviderResponse(true);
    writeUnconfirmed = false;
    return confirmed;
  } finally {
    if (!writeUnconfirmed) await releaseLock(key, lock.token);
  }
}

export async function resolveHostedAuthConfig(client: ComposioClient, projectId: string, toolkit: ComposioToolkit,
  configs: ComposioAuthConfig[], selectedId: string | undefined, expected: { key: string; revision: string }, beforeCreate: () => Promise<void>) {
  const usable = (config: ComposioAuthConfig) => canUseHostedConfig(toolkit, config);
  if (selectedId !== undefined) {
    const selected = configs.find(config => config.id === selectedId && usable(config));
    if (selected && existingSetupKey(expected.revision, toolkit, selected) === expected.key) return selected;
    throw new ConnectorError('AUTH_CONFIG_UNAVAILABLE', 'This authentication configuration is no longer available. Refresh and select a supported configuration.', 422);
  }
  // An automatic plan is not consent to use an existing config, even one with the same scheme.
  if (configs.some(usable)) throw changedSetup();
  const plan = automaticConnectionPlan(toolkit, configs);
  if (!plan) {
    const { kind } = connectionSetup(toolkit, configs, expected.revision);
    if (kind === 'no_auth') throw new ConnectorError('AUTH_NOT_REQUIRED', 'This connector does not need an account.', 422);
    if (kind === 'unavailable') throw new ConnectorError('CONNECTOR_SETUP_UNAVAILABLE', 'The provider has disabled this connector.', 422);
    throw adminSetupRequired();
  }
  if (automaticSetupKey(expected.revision, toolkit, plan) !== expected.key) throw changedSetup();
  const managed = plan.kind === 'managed_oauth';
  return ensureAuthConfig(client, projectId, toolkit.slug, {
    scheme: plan.auth_scheme, managed, appId: plan.appId,
    beforeCreate: async () => {
      const latest = await getToolkit(client, toolkit.slug);
      const latestPlan = automaticConnectionPlan(latest, []);
      if (!latestPlan || automaticSetupKey(expected.revision, latest, latestPlan) !== expected.key) throw changedSetup();
      await beforeCreate();
    },
    body: {
      ...(managed ? { type: 'use_composio_managed_auth', ...(plan.appId && { managed_app_id: plan.appId }) }
        : { type: 'use_custom_auth', authScheme: plan.auth_scheme }),
      name: plan.name, credentials: plan.values,
    },
    checkConfigs: current => {
      if (current.some(usable)) throw changedSetup();
      if (current.length) throw adminSetupRequired();
    },
    canUseCreated: config => usable(config) && config.authScheme === plan.auth_scheme && config.isManaged === managed &&
      config.managedAppId === plan.appId,
  });
}

function adminSetupRequired() {
  return new ConnectorError('AUTH_CONFIG_ADMIN_REQUIRED', 'Ask your Composio project administrator to configure an approved authentication method.', 422);
}
function changedSetup() {
  return new ConnectorError('AUTH_CONFIG_UNAVAILABLE', 'The sign-in options changed. Refresh and confirm the current option.', 409);
}
