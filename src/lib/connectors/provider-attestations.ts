import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ConnectorError } from './types';

export function connectorCallbackUrl(): string {
  try {
    const origin = new URL(process.env.CONNECTORS_WEB_ORIGIN || '');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error();
    return new URL('/connectors/callback', origin).toString();
  } catch {
    throw new ConnectorError('PROVIDER_SETUP_REQUIRED', 'Configure the trusted connector callback origin before connecting accounts.', 503);
  }
}

const setupRequired = () => new ConnectorError('PROVIDER_SETUP_REQUIRED',
  'Verify this credential’s Composio project and OAuth callback verifier before using connected accounts.', 503);
const unavailable = () => new ConnectorError('STORAGE_UNAVAILABLE', 'The connector provider attestation could not be verified.', 503);

/** Called only after site authorization, with a server-derived ciphertext revision. Never cache authority. */
export async function readByokProviderBinding(siteId: string, revision: string) {
  if (typeof window !== 'undefined') throw unavailable();
  if (!z.string().uuid().safeParse(siteId).success || !/^[a-f0-9]{64}$/.test(revision)) throw setupRequired();
  const callbackUrl = connectorCallbackUrl();
  let result;
  try {
    result = await supabaseAdmin.rpc('connector_attested_provider_project', {
      p_site_id: siteId, p_credential_revision: revision, p_oauth_verifier_url: callbackUrl,
    }).abortSignal(AbortSignal.timeout(5_000));
  } catch { throw unavailable(); } // Never reflect raw RPC/transport data into the response.
  if (result?.error !== null) throw unavailable();
  if (result.data === null) throw setupRequired();
  if (typeof result.data !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.data)) throw unavailable();
  return { projectId: result.data, callbackUrl };
}
