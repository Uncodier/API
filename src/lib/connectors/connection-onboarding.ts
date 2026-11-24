import { createHash } from 'node:crypto';
import type { ComposioAuthConfig, ComposioToolkit } from './composio-catalog';
import { managedOAuthPreset } from './managed-oauth-policy';

const oauth = ['OAUTH2', 'OAUTH1'];
const dynamicOAuth = ['DCR_OAUTH'];
const credentials = ['API_KEY', 'BEARER_TOKEN', 'BASIC', 'BASIC_WITH_JWT'];
const hostedSchemes = new Set([...oauth, ...dynamicOAuth, ...credentials]);
export const isHostedCredentialScheme = (scheme: string | null) => scheme !== null && credentials.includes(scheme);

export function canHostConnection(toolkit: ComposioToolkit) {
  return toolkit.type === 'native' && toolkit.enabled !== false;
}

export function needsNoAccount(toolkit: ComposioToolkit) {
  return toolkit.auth_schemes?.length === 1 && toolkit.auth_schemes[0] === 'NO_AUTH';
}

export function canUseHostedConfig(toolkit: ComposioToolkit, config: ComposioAuthConfig) {
  return canHostConnection(toolkit) && !needsNoAccount(toolkit) && config.toolkitSlug === toolkit.slug &&
    config.status === 'ENABLED' && config.id.length <= 150 &&
    !config.hasSharedFields && !config.hasProxy && config.authScheme !== null && hostedSchemes.has(config.authScheme) &&
    (!isHostedCredentialScheme(config.authScheme) || (!config.hasConfigCredentials &&
      (config.hasRequiredAccountFields ?? toolkit.account_credential_schemes?.includes(config.authScheme)))) &&
    (toolkit.slug !== 'supabase' || config.authScheme === 'OAUTH2');
}

export function automaticConnectionPlan(toolkit: ComposioToolkit, configs: ComposioAuthConfig[]) {
  if (!canHostConnection(toolkit) || needsNoAccount(toolkit) || toolkit.slug === 'supabase') return null;
  // Do not shadow a disabled, shared, proxied or otherwise incompatible config
  // with a second config. It may represent an explicit project-admin decision.
  if (configs.length) return null;
  const calendar = managedOAuthPreset(toolkit);
  const managed = toolkit.default_managed_auth;
  const scheme = calendar ? 'OAUTH2' : toolkit.slug !== 'googlecalendar' && managed && oauth.includes(managed.scheme) ? managed.scheme : null;
  if (scheme) {
    // Without a stable app ID the default cannot be pinned when the config is created.
    if (!managed?.appId) return null;
    return {
      kind: 'managed_oauth' as const, auth_scheme: scheme, appId: managed.appId,
      name: calendar?.name ?? `Makinari ${toolkit.slug} (${scheme})`,
      // Never promote the advertised scope ceiling to requested permissions.
      values: calendar ? { scopes: calendar.scopes } : {},
    };
  }
  for (const scheme of [...dynamicOAuth, ...credentials]) {
    if (!toolkit.empty_config_schemes?.includes(scheme) ||
      (isHostedCredentialScheme(scheme) && !toolkit.account_credential_schemes?.includes(scheme))) continue;
    return {
      kind: dynamicOAuth.includes(scheme) ? 'dynamic_oauth' as const : 'hosted_credentials' as const,
      auth_scheme: scheme, appId: null, name: `Makinari ${toolkit.slug} (${scheme})`, values: {},
    };
  }
  return null;
}

// Optimistic concurrency token, not authorization. Compare only against a fresh server plan.
function setupKey(revision: string, toolkit: ComposioToolkit, selection: unknown[]) {
  return createHash('sha256').update(JSON.stringify(['hosted-v1', revision, toolkit.slug, toolkit.toolkit_type, ...selection])).digest('hex');
}

export function existingSetupKey(revision: string, toolkit: ComposioToolkit, config: ComposioAuthConfig) {
  return setupKey(revision, toolkit, ['existing', config.id, config.name, config.authScheme, config.isManaged, config.managedAppId]);
}

export function automaticSetupKey(revision: string, toolkit: ComposioToolkit, plan: NonNullable<ReturnType<typeof automaticConnectionPlan>>) {
  return setupKey(revision, toolkit, [plan.kind, plan.auth_scheme, plan.appId, plan.values]);
}

/** Discovery only: the connection POST rechecks provider metadata. */
export function connectionSetup(toolkit: ComposioToolkit, configs: ComposioAuthConfig[], revision: string) {
  if (!canHostConnection(toolkit)) return { kind: 'unavailable' as const };
  if (needsNoAccount(toolkit)) return { kind: 'no_auth' as const };
  const config_ids = configs.filter(config => canUseHostedConfig(toolkit, config)).map(config => config.id);
  if (config_ids.length) return { kind: 'existing' as const, config_ids };
  const plan = automaticConnectionPlan(toolkit, configs);
  if (plan) return { kind: plan.kind, auth_scheme: plan.auth_scheme, setup_key: automaticSetupKey(revision, toolkit, plan) };
  if (toolkit.slug === 'supabase' && toolkit.auth_schemes.includes('API_KEY')) return { kind: 'supabase_token' as const };
  return { kind: toolkit.auth_schemes.some(scheme => oauth.includes(scheme)) ? 'admin_oauth' as const : 'admin_setup' as const };
}