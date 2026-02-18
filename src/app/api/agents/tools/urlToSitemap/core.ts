import { fetchHtml } from '@/lib/utils/html-utils';
import { findSitemap, parseSitemap } from '@/lib/utils/sitemap-utils';

export interface UrlToSitemapResult {
  url: string;
  sitemap_url: string | null;
  urls: string[];
}

export async function urlToSitemapCore(url: string): Promise<UrlToSitemapResult> {
  let sitemapUrl = await findSitemap(url);
  let urls: string[] = [];

  if (sitemapUrl) {
    console.log(`[urlToSitemap] Found sitemap: ${sitemapUrl}`);
    try {
      const sitemapContent = await fetchHtml(sitemapUrl);
      urls = await parseSitemap(sitemapContent);
    } catch (e) {
      console.error(`[urlToSitemap] Error fetching/parsing sitemap: ${e}`);
    }
  } else {
    console.log(`[urlToSitemap] No sitemap found for ${url}`);
  }

  return {
    url,
    sitemap_url: sitemapUrl,
    urls,
  };
}

