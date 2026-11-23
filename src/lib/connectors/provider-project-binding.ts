import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ConnectorError } from './types';
import { connectorCallbackUrl, readByokProviderBinding } from './provider-attestations';

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

export async function readTokenProviderBinding(site: string, revision: string) {
  return revision.startsWith('platform:') ? { projectId: platformProjectId(revision) } : readProviderBinding(site, revision);
}
