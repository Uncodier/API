import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';
import { isServiceApiKeyCredential } from './api-key-credential';

export type ToolRequestPrincipal = { internal: boolean; userId: string | null; siteId: string | null };

/** Body/user metadata headers are never credentials. Internal BFFs may forward a resolved actor. */
export async function resolveToolRequestPrincipal(request: Request): Promise<ToolRequestPrincipal | null> {
  const authorization = request.headers.get('authorization');
  const apiKey = request.headers.get('x-api-key')
    || (authorization?.startsWith('Bearer ') ? authorization.slice(7) : null);
  if (!apiKey) return null;
  if (await isServiceApiKeyCredential(apiKey)) return { internal: true, userId: null, siteId: null };
  try {
    if (!request.headers.has('x-api-key') && apiKey.split('.').length === 3) {
      const { data, error } = await supabaseAdmin.auth.getUser(apiKey);
      return !error && data.user ? { internal: false, userId: data.user.id, siteId: null } : null;
    }
    const { isValid, keyData } = await ApiKeyService.validateApiKey(apiKey);
    if (!isValid || !keyData?.user_id) return null;
    return { internal: false, userId: keyData.user_id, siteId: keyData.site_id };
  } catch {
    return null;
  }
}

/** Evaluate current membership/license for the bound actor, including tenant-bound API keys. */
export async function canToolPrincipalAccessSite(principal: ToolRequestPrincipal, siteId: string): Promise<boolean> {
  if (principal.internal) return true;
  if (!principal.userId || (principal.siteId && principal.siteId !== siteId)) return false;
  try {
    const signal = AbortSignal.timeout(5_000);
    const { data, error } = await supabaseAdmin.rpc('site_user_has_effective_access', {
      p_site_id: siteId, p_user_id: principal.userId,
    }).abortSignal(signal);
    return !signal.aborted && !error && data === true;
  } catch {
    return false;
  }
}