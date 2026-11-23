import { z } from 'zod';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { decryptToken } from '@/lib/utils/token-decryption';
import { CONNECTOR_COLUMNS, PROVIDER_COLUMNS, ConnectorError, connectorToolAccessMode,
  type Connector, type ConnectorMemberGrant, type ConnectorPolicy, type ConnectorProvider } from './types';

const uuid = z.string().uuid();
const deadline = () => AbortSignal.timeout(5_000);

export function connectorDatabaseError(error: unknown): never {
  const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
  if (code === 'P0C01') throw new ConnectorError('CATALOG_OPT_OUT_SEPARATE', 'Save the catalogue opt-out separately from other policy changes.', 409);
  if (code === '40001') throw new ConnectorError('REVISION_CONFLICT', 'Configuration changed. Reload before trying again.', 409);
  if (code === '42501') throw new ConnectorError('ACCESS_DENIED', 'Connector access denied.', 403);
  if (code === '23503' || code === '23514' || code === '22023') {
    throw new ConnectorError('INVALID_REFERENCE', 'The selected connector access references are not valid.', 400);
  }
  throw new ConnectorError('STORAGE_UNAVAILABLE', 'Connector storage is unavailable. Check migration readiness.', 503);
}

/** The database rechecks license, membership, screen and site-wide location access. */
export async function requireConnectorSiteAccess(siteId: string, userId: string, manager = false) {
  uuid.parse(siteId); uuid.parse(userId);
  const { data, error } = await supabaseAdmin.rpc('connector_site_access', {
    p_site_id: siteId, p_user_id: userId,
  }).abortSignal(deadline());
  if (error) connectorDatabaseError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.can_view !== true || (manager && row.can_manage !== true)) {
    throw new ConnectorError('ACCESS_DENIED', 'Connector access denied.', 403);
  }
  return { can_view: true as const, can_manage: row.can_manage === true };
}

export async function listVisibleConnectors(siteId: string, userId: string): Promise<Connector[]> {
  await requireConnectorSiteAccess(siteId, userId);
  // Filter inside SQL before applying the result cap, using the shared RLS visibility rules.
  const { data, error, count } = await supabaseAdmin.rpc('connector_list_visible', {
    p_site_id: siteId, p_user_id: userId,
  }, { count: 'exact' }).select(CONNECTOR_COLUMNS).order('display_name').limit(1000).abortSignal(deadline());
  if (error) connectorDatabaseError(error);
  if ((count ?? 0) > 1000) throw new ConnectorError('CATALOG_LIMIT', 'Too many connectors for this request.', 422);
  if (!Array.isArray(data) || count !== data.length) connectorDatabaseError(null);
  return data as Connector[];
}

export async function getVisibleConnector(siteId: string, userId: string, id: string): Promise<Connector> {
  uuid.parse(id);
  await requireConnectorSiteAccess(siteId, userId);
  const { data, error } = await supabaseAdmin.rpc('connector_list_visible', {
    p_site_id: siteId, p_user_id: userId, p_connector_id: id,
  }).select(CONNECTOR_COLUMNS).abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  if (!data) throw new ConnectorError('NOT_FOUND', 'Connector not found.', 404);
  const connector = data as Connector;
  if (connector.id !== id || connector.site_id !== siteId) connectorDatabaseError(null);
  return connector;
}

export async function loadConnectorCredential(siteId: string): Promise<{ apiKey: string; revision: string; source: 'byok' | 'platform' }> {
  uuid.parse(siteId);
  const { data, error } = await supabaseAdmin.from('site_secrets').select('encrypted_value')
    .eq('site_id', siteId).eq('provider', 'composio').eq('use_case', 'integrations')
    .is('instance_id', null).abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  // Only an absent BYOK row permits the platform credential. Database/decryption
  // errors must never silently move a customer's work to another billing project.
  if (!data) {
    const apiKey = (process.env.COMPOSIO_API_KEY || process.env.COMPOSIO_PROJECT_API_KEY || '').trim();
    if (!apiKey) throw new ConnectorError('NOT_CONFIGURED', 'No platform or workspace Composio credential is configured.', 422);
    if (apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey)) throw new ConnectorError('CREDENTIAL_UNAVAILABLE', 'The platform connector credential is invalid.', 503);
    return { apiKey, revision: `platform:${createHash('sha256').update(apiKey).digest('hex')}`, source: 'platform' };
  }
  if (!data.encrypted_value) throw new ConnectorError('CREDENTIAL_UNAVAILABLE', 'The workspace connector credential could not be read.', 503);
  const apiKey = decryptToken(data.encrypted_value);
  if (!apiKey) throw new ConnectorError('CREDENTIAL_UNAVAILABLE', 'The connector credential could not be read.', 503);
  return { apiKey, revision: createHash('sha256').update(data.encrypted_value).digest('hex'), source: 'byok' };
}

export async function getConnectorProvider(siteId: string, providerId?: string): Promise<ConnectorProvider | null> {
  let query = supabaseAdmin.from('site_connector_providers').select(PROVIDER_COLUMNS)
    .eq('site_id', siteId).eq('provider', 'composio');
  if (providerId) query = query.eq('id', providerId);
  const { data, error } = await query.abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  return data as ConnectorProvider | null;
}

export async function getConnectorPolicy(siteId: string, connectorId: string): Promise<ConnectorPolicy> {
  const { data, error } = await supabaseAdmin.from('connector_policies')
    .select('tool_access_mode,catalog_reads,allowed_tools,allowed_hosts,require_approval,support_publication,revision')
    .eq('site_id', siteId).eq('connector_id', connectorId).abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  return { ...(data ?? { allowed_tools: [], allowed_hosts: [], require_approval: true }),
    tool_access_mode: connectorToolAccessMode(data?.tool_access_mode), catalog_reads: data?.catalog_reads === true };
}

export async function getMemberGrant(siteId: string, userId: string, connectorId: string): Promise<ConnectorMemberGrant | null> {
  const { data, error } = await supabaseAdmin.from('connector_members')
    .select('user_id,can_view,can_use,expires_at,revoked_at').eq('site_id', siteId)
    .eq('connector_id', connectorId).eq('user_id', userId).abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  return data;
}
