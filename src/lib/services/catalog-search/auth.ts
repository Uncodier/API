import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { extractApiKeyCredential, isServiceApiKeyCredential } from '@/lib/security/api-key-credential';
import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';
import type { CatalogPrincipal, CatalogSearchInput } from './contract';

export class CatalogAuthorizationError extends Error {
  constructor(public status: 401 | 403 = 403) { super('Catalog search access denied'); }
}

export async function requireCatalogService(request: Request): Promise<void> {
  if (!await isServiceApiKeyCredential(extractApiKeyCredential(request))) {
    throw new CatalogAuthorizationError(401);
  }
}

/** Verify credentials again in the handler; identity headers are not credentials. */
export async function authorizeCatalogRequest(
  request: Request, input: Pick<CatalogSearchInput, 'site_id' | 'channel'>,
): Promise<CatalogPrincipal> {
  const service = await isServiceApiKeyCredential(extractApiKeyCredential(request));
  const publicChannel = input.channel === 'shop' || input.channel === 'marketplace';
  if (input.channel !== 'marketplace' && !input.site_id) throw new CatalogAuthorizationError();
  if (service) {
    // Only an actually authenticated BFF may assert its server-resolved shopper bucket.
    const forwarded = request.headers.get('x-catalog-client-id');
    const clientId = forwarded && /^[a-f0-9]{64}$/.test(forwarded) ? forwarded : null;
    return { scope: `${publicChannel ? 'public' : 'service'}:${input.channel}:${input.site_id || 'all'}`,
      rateIdentity: clientId ? `catalog-client:${clientId}` : 'catalog-service',
      service: true, aggregateOnly: !clientId };
  }
  const authorization = request.headers.get('authorization') || '';
  const credential = extractApiKeyCredential(request);
  const userBearer = authorization.startsWith('Bearer ') && !request.headers.has('x-api-key')
    && authorization.slice(7).split('.').length === 3;
  if (!userBearer && credential) {
    const validation = await ApiKeyService.validateApiKey(credential);
    if (!validation.isValid || !validation.keyData) throw new CatalogAuthorizationError(401);
    // Validation may use a short credential cache. Recheck current revocation,
    // scope and tenant before reading any catalog/result cache.
    const current = await supabaseAdmin.from('api_keys')
      .select('id,user_id,site_id,scopes,status,expires_at').eq('id', validation.keyData.id)
      .abortSignal(AbortSignal.timeout(5_000)).maybeSingle();
    const key = current.data;
    if (current.error || !key || key.status !== 'active'
      || !Number.isFinite(Date.parse(key.expires_at)) || Date.parse(key.expires_at) <= Date.now()) {
      throw new CatalogAuthorizationError(401);
    }
    if (!key.site_id || input.site_id !== key.site_id || !Array.isArray(key.scopes)
      || !key.scopes.some((scope: unknown) => scope === 'read' || scope === '*')) {
      throw new CatalogAuthorizationError();
    }
    if (!publicChannel) {
      if (!key.user_id) throw new CatalogAuthorizationError();
      const access = await supabaseAdmin.rpc('site_user_has_effective_access', {
        p_site_id: key.site_id, p_user_id: key.user_id,
      }).abortSignal(AbortSignal.timeout(5_000));
      if (access.error || access.data !== true) throw new CatalogAuthorizationError();
    }
    const actor = createHash('sha256').update(key.id).digest('hex');
    return { scope: publicChannel ? `public:${input.channel}:${key.site_id}`
      : `api-key:${actor}:${key.site_id}:${input.channel}`, rateIdentity: `catalog-key:${actor}` };
  }
  if (!userBearer) throw new CatalogAuthorizationError(401);
  const { data, error } = await supabaseAdmin.auth.getUser(authorization.slice(7));
  if (error || !data.user) throw new CatalogAuthorizationError(401);
  if (!publicChannel) {
    const access = await supabaseAdmin.rpc('site_user_has_effective_access', {
      p_site_id: input.site_id, p_user_id: data.user.id,
    }).abortSignal(AbortSignal.timeout(5_000));
    if (access.error || access.data !== true) throw new CatalogAuthorizationError();
  }
  const actor = createHash('sha256').update(data.user.id).digest('hex');
  return { scope: publicChannel ? `public:${input.channel}:${input.site_id || 'all'}`
    : `user:${actor}:${input.site_id}:${input.channel}`, rateIdentity: `catalog-user:${actor}`, service: false };
}