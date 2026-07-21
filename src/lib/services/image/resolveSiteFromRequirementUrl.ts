import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Resolves a site ID from an Origin or Referer URL by checking
 * requirement_status.preview_url and requirement_status.endpoint_url
 * 
 * @param originOrReferer The Origin or Referer header value
 * @returns The matched site_id or null if no exact hostname match is found
 */
export async function resolveSiteFromRequirementUrl(originOrReferer: string | null): Promise<string | null> {
  if (!originOrReferer) return null;

  try {
    const hn = !originOrReferer.startsWith('http') 
      ? new URL(`https://${originOrReferer}`).hostname 
      : new URL(originOrReferer).hostname;

    if (!hn || hn === 'localhost' || hn === '127.0.0.1') {
      return null;
    }

    // First search with ilike to filter rows fast
    const { data, error } = await supabaseAdmin
      .from('requirement_status')
      .select('site_id, preview_url, endpoint_url')
      .or(`preview_url.ilike.%${hn}%,endpoint_url.ilike.%${hn}%`)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error || !data || data.length === 0) {
      return null;
    }

    // Then enforce an exact hostname match (anti-poisoning)
    for (const row of data) {
      const isHostnameMatch = (urlStr: string | null) => {
        if (!urlStr) return false;
        try {
          const urlHn = !urlStr.startsWith('http') 
            ? new URL(`https://${urlStr}`).hostname 
            : new URL(urlStr).hostname;
          return urlHn === hn;
        } catch {
          return false;
        }
      };

      if (isHostnameMatch(row.preview_url) || isHostnameMatch(row.endpoint_url)) {
        return row.site_id; // Exact match found
      }
    }

    return null;
  } catch (error) {
    console.warn('[resolveSiteFromRequirementUrl] Error parsing/resolving URL:', error);
    return null;
  }
}
