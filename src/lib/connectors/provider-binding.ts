import { z } from 'zod';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, getConnectorProvider, loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { ConnectorError, PROVIDER_COLUMNS, type ConnectorProvider } from './types';

const bindingSchema = z.object({
  site_id: z.string().uuid(), project_id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  credential_revision: z.string().regex(/^[a-f0-9]{64}$/), oauth_verifier_url: z.string().url(),
}).strict();

export function connectorCallbackUrl(): string {
  try {
    const origin = new URL(process.env.CONNECTORS_WEB_ORIGIN || '');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error();
    return new URL('/connectors/callback', origin).toString();
  } catch {
    throw new ConnectorError('PROVIDER_SETUP_REQUIRED', 'Configure the trusted connector callback origin before connecting accounts.', 503);
  }
}

/**
 * Explicit deployment attestation, NOT an inferred identity or a provider API read.
 * Public project endpoints require org/user credentials; a project key alone does
 * not provide a documented current-project/verifier introspection contract.
 */
function platformProjectId(credentialRevision: string) {
  const key = (process.env.COMPOSIO_API_KEY || process.env.COMPOSIO_PROJECT_API_KEY || '').trim();
  const projectId = process.env.COMPOSIO_PROJECT_ID?.trim();
  if (!key || !projectId || !/^[a-zA-Z0-9_-]{1,200}$/.test(projectId)) {
    throw new ConnectorError('COMPOSIO_PROJECT_SETUP_REQUIRED', 'The Composio project ID for the platform key is not configured.', 503);
  }
  const expectedRevision = `platform:${createHash('sha256').update(key).digest('hex')}`;
  if (credentialRevision !== expectedRevision) throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'The platform credential changed.', 409);
  return projectId;
}

export function readProviderBinding(siteId: string, credentialRevision: string) {
  z.string().uuid().parse(siteId);
  if (credentialRevision.startsWith('platform:')) {
    return { projectId: platformProjectId(credentialRevision), callbackUrl: connectorCallbackUrl() };
  }
  let bindings: z.infer<typeof bindingSchema>[];
  try { bindings = z.array(bindingSchema).max(1000).parse(JSON.parse(process.env.CONNECTOR_PROVIDER_BINDINGS || '[]')); }
  catch { throw new ConnectorError('PROVIDER_SETUP_REQUIRED', 'Connector provider bindings are not configured correctly.', 503); }
  const matches = bindings.filter(binding => binding.site_id === siteId && binding.credential_revision === credentialRevision);
  const callbackUrl = connectorCallbackUrl();
  if (matches.length !== 1 || matches[0].oauth_verifier_url !== callbackUrl) {
    throw new ConnectorError('PROVIDER_SETUP_REQUIRED', 'Verify this credential’s Composio project and OAuth callback verifier before connecting accounts.', 503);
  }
  return { projectId: matches[0].project_id, callbackUrl };
}

/** Called only after an authenticated manager explicitly begins connection setup. */
export async function prepareConnectorProvider(siteId: string, userId: string) {
  return prepareProvider(siteId, userId, readProviderBinding);
}

export async function prepareConnectorTokenProvider(siteId: string, userId: string) {
  return prepareProvider(siteId, userId, readTokenProviderBinding);
}

export function readTokenProviderBinding(site: string, revision: string) {
  return revision.startsWith('platform:') ? { projectId: platformProjectId(revision) } : readProviderBinding(site, revision);
}

async function prepareProvider<T extends { projectId: string }>(siteId: string, userId: string, resolve: (site: string, revision: string) => T) {
  await requireConnectorSiteAccess(siteId, userId, true);
  const credential = await loadConnectorCredential(siteId);
  const binding = resolve(siteId, credential.revision);
  let provider = await getConnectorProvider(siteId);
  if (provider && (provider.project_id !== binding.projectId || provider.provider_user_id !== siteId)) {
    throw new ConnectorError('PROVIDER_PROJECT_CHANGED', 'The provider project changed. Existing accounts require an explicit migration.', 409);
  }
  if (!provider) {
    const result = await supabaseAdmin.from('site_connector_providers').insert({
      site_id: siteId, provider: 'composio', project_id: binding.projectId,
      provider_user_id: siteId, credential_revision: credential.revision, status: 'active',
    }).select(PROVIDER_COLUMNS).abortSignal(AbortSignal.timeout(5_000)).single();
    if (result.error?.code === '23505') provider = await getConnectorProvider(siteId);
    else if (result.error) connectorDatabaseError(result.error);
    else provider = result.data as ConnectorProvider;
  }
  if (!provider || provider.project_id !== binding.projectId || provider.credential_revision !== credential.revision || provider.status !== 'active') {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'Provider configuration requires explicit revalidation after credential changes.', 409);
  }
  return { ...binding, provider, credential };
}