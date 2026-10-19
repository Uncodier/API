import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  getCachedJson,
  setCachedJson,
  sha256,
} from './upstash-rest';
import { isInternalServiceRequest } from './request-rate-limit';

interface ApiKeyMetadata {
  site_id?: unknown;
  user_id?: unknown;
  scopes?: unknown;
}

export interface RequestSitePrincipal {
  internal: boolean;
  userId: string | null;
  siteId: string | null;
}

function hostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${value}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}

function apiKeyMetadata(request: Request): ApiKeyMetadata | null {
  const value = request.headers.get('x-api-key-data');
  if (!value) return null;
  try {
    return JSON.parse(value) as ApiKeyMetadata;
  } catch {
    return null;
  }
}

export function getRequestSitePrincipal(request: Request): RequestSitePrincipal {
  const keyData = apiKeyMetadata(request);
  return {
    internal: isInternalServiceRequest(request),
    userId: request.headers.get('x-auth-user-id')
      || (typeof keyData?.user_id === 'string' ? keyData.user_id : null),
    siteId: typeof keyData?.site_id === 'string' ? keyData.site_id : null,
  };
}

export async function canAccessSite(
  request: Request,
  siteId: string,
): Promise<boolean> {
  const principal = getRequestSitePrincipal(request);
  if (principal.internal) return true;
  if (principal.siteId) {
    return principal.siteId === siteId;
  }

  const userId = principal.userId;
  if (!userId) return false;

  // A cached positive membership or ownership flag may outlive a trial seat.
  // SQL evaluates the authenticated actor's current license, including expiry.
  const signal = AbortSignal.timeout(10_000);
  let removeAbortListener = () => {};
  try {
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => reject(new Error('Site authorization unavailable'));
      signal.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    });
    const { data, error } = await Promise.race([
      supabaseAdmin.rpc('site_user_has_effective_access', { p_site_id: siteId, p_user_id: userId }).abortSignal(signal),
      aborted,
    ]);
    return !signal.aborted && !error && data === true;
  } catch {
    return false;
  } finally {
    removeAbortListener();
  }
}

export async function originBelongsToSite(
  request: Request,
  siteId: string,
  knownSiteUrl?: string | null,
): Promise<boolean> {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const originHost = hostname(origin);
  if (!originHost) return false;
  if (
    process.env.NODE_ENV !== 'production'
    && (originHost === 'localhost' || originHost === '127.0.0.1')
  ) {
    return true;
  }

  const cacheKey = `auth:site-origin:${siteId}:${await sha256(originHost)}`;
  const cached = await getCachedJson<{ allowed: boolean }>(cacheKey);
  if (cached) return cached.allowed;

  let siteUrl = knownSiteUrl;
  if (siteUrl === undefined) {
    const { data: site } = await supabaseAdmin
      .from('sites')
      .select('url')
      .eq('id', siteId)
      .maybeSingle();
    siteUrl = site?.url;
  }
  let allowed = Boolean(siteUrl && hostname(siteUrl) === originHost);

  if (!allowed) {
    const { data: domains } = await supabaseAdmin
      .from('allowed_domains')
      .select('domain')
      .eq('site_id', siteId);
    allowed = Boolean(
      domains?.some(({ domain }) => hostname(domain) === originHost),
    );
  }

  await setCachedJson(cacheKey, { allowed }, allowed ? 300 : 30);
  return allowed;
}
