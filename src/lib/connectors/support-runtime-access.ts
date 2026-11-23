import { supabaseAdmin } from '@/lib/database/supabase-client';
import { requireConnectorSiteAccess, connectorDatabaseError } from './access';
import { memberSupportScope, type SupportConnectorScope } from './support-runtime-contract';
import { ConnectorError } from './types';

export const denied = () => new ConnectorError('SUPPORT_UNAVAILABLE', 'This support operation is unavailable.', 403);

export async function candidateWindow(scope: SupportConnectorScope, after: string, exact?: string) {
  const member = memberSupportScope.parse(scope);
  await requireConnectorSiteAccess(member.siteId, member.userId);
  let query = supabaseAdmin.rpc('connector_list_visible', { p_site_id: member.siteId, p_user_id: member.userId,
    ...(exact ? { p_connector_id: exact } : {}) }).select('id').eq('enabled', true)
    .eq('revocation_pending', false).eq('provider_status', 'ACTIVE').order('id').limit(6);
  if (after) query = query.gt('id', after);
  const { data, error } = await query.abortSignal(AbortSignal.timeout(5000));
  if (error || !Array.isArray(data) || data.length > 6) connectorDatabaseError(error);
  return data.map((row: { id: string }) => ({ id: row.id }));
}
