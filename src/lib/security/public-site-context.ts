import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getCachedJson, setCachedJson, sha256 } from './upstash-rest';

export interface PublicSiteContext {
  id: string;
  url: string | null;
  name: string | null;
  description: string | null;
}

export function hasExplicitPublicSiteContext(request: Request): boolean {
  const params = new URL(request.url).searchParams;
  return ['site_id', 'site_url', 'url', 'domain']
    .some((name) => Boolean(params.get(name)?.trim()));
}

interface CachedSiteResolution {
  site: PublicSiteContext | null;
}

function normalizedHostname(value: string | null): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const parsed = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`,
    );
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (
      !hostname
      || hostname.length > 253
      || !/^[a-z\d.-]+$/.test(hostname)
      || hostname.includes('..')
    ) {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
}

function exactDomainVariants(hostname: string): string[] {
  const bare = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  const hosts = new Set([hostname, bare, `www.${bare}`]);
  return Array.from(hosts).flatMap((host) => [
    host,
    `https://${host}`,
    `https://${host}/`,
    `http://${host}`,
    `http://${host}/`,
  ]);
}

async function cachedResolution(
  key: string,
): Promise<CachedSiteResolution | null> {
  return getCachedJson<CachedSiteResolution>(key);
}

async function cacheResolution(
  key: string,
  site: PublicSiteContext | null,
): Promise<void> {
  await setCachedJson(key, { site }, site ? 300 : 30);
}

export async function resolvePublicSiteContext(
  request: Request,
): Promise<PublicSiteContext | null> {
  const url = new URL(request.url);
  const siteId = url.searchParams.get('site_id')?.trim();
  if (siteId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(siteId)) {
      return null;
    }
    const cacheKey = `public:site:id:${siteId}`;
    const cached = await cachedResolution(cacheKey);
    if (cached) return cached.site;
    const { data, error } = await supabaseAdmin
      .from('sites')
      .select('id, url, name, description')
      .eq('id', siteId)
      .maybeSingle();
    if (error) throw new Error(`Site lookup failed: ${error.message}`);
    const site = (data as PublicSiteContext | null) ?? null;
    await cacheResolution(cacheKey, site);
    return site;
  }

  const requestedUrl = url.searchParams.get('site_url')
    || url.searchParams.get('url')
    || url.searchParams.get('domain')
    || request.headers.get('origin');
  const hostname = normalizedHostname(requestedUrl);
  if (!hostname) return null;

  const cacheKey = `public:site:host:${await sha256(hostname)}`;
  const cached = await cachedResolution(cacheKey);
  if (cached) return cached.site;

  const variants = exactDomainVariants(hostname);
  const { data: directSite, error: directError } = await supabaseAdmin
    .from('sites')
    .select('id, url, name, description')
    .in('url', variants)
    .limit(1)
    .maybeSingle();
  if (directError) throw new Error(`Site lookup failed: ${directError.message}`);
  if (directSite) {
    const site = directSite as PublicSiteContext;
    await cacheResolution(cacheKey, site);
    return site;
  }

  const { data: domain, error: domainError } = await supabaseAdmin
    .from('allowed_domains')
    .select('site_id')
    .in('domain', variants)
    .limit(1)
    .maybeSingle();
  if (domainError) throw new Error(`Domain lookup failed: ${domainError.message}`);
  if (!domain?.site_id) {
    await cacheResolution(cacheKey, null);
    return null;
  }

  const { data: mappedSite, error: mappedError } = await supabaseAdmin
    .from('sites')
    .select('id, url, name, description')
    .eq('id', domain.site_id)
    .maybeSingle();
  if (mappedError) throw new Error(`Site lookup failed: ${mappedError.message}`);
  const site = (mappedSite as PublicSiteContext | null) ?? null;
  await cacheResolution(cacheKey, site);
  return site;
}
