import { z } from 'zod';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, getConnectorProvider, loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { ConnectorError, PROVIDER_COLUMNS, type ConnectorProvider } from './types';
import { connectorCallbackUrl, readByokProviderBinding } from './provider-attestations';

export { connectorCallbackUrl };

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

export async function readProviderBinding(siteId: string, credentialRevision: string) {
  z.string().uuid().parse(siteId);
  if (credentialRevision.startsWith('platform:')) {
    return { projectId: platformProjectId(credentialRevision), callbackUrl: connectorCallbackUrl() };
  }
  return readByokProviderBinding(siteId, credentialRevision);
}

/** Called only after an authenticated manager explicitly begins connection setup. */
export async function prepareConnectorProvider(siteId: string, userId: string) {
  return prepareProvider(siteId, userId, readProviderBinding);
}

export async function prepareConnectorTokenProvider(siteId: string, userId: string) {
  return prepareProvider(siteId, userId, readTokenProviderBinding);
}

export async function readTokenProviderBinding(site: string, revision: string) {
  return revision.startsWith('platform:') ? { projectId: platformProjectId(revision) } : readProviderBinding(site, revision);
}

async function prepareProvider<T extends { projectId: string }>(siteId: string, userId: string, resolve: (site: string, revision: string) => Promise<T>) {
  await requireConnectorSiteAccess(siteId, userId, true);
  const credential = await loadConnectorCredential(siteId);
  const binding = await resolve(siteId, credential.revision);
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
  if (!provider || provider.site_id !== siteId || provider.provider_user_id !== siteId ||
    provider.project_id !== binding.projectId || provider.credential_revision !== credential.revision || provider.status !== 'active') {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'Provider configuration requires explicit revalidation after credential changes.', 409);
  }
  return { ...binding, provider, credential };
}