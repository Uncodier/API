import * as cheerio from 'cheerio';
import { fetchHtml } from '@/lib/utils/html-utils';

/**
 * Finds the sitemap URL for a given website URL.
 * 
 * @param url The website URL
 * @returns The sitemap URL if found, or null
 */
export async function findSitemap(url: string): Promise<string | null> {
  try {
    const parsedUrl = new URL(url);
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

    // 1. Check robots.txt
    try {
      const robotsTxtUrl = `${baseUrl}/robots.txt`;
      const robotsTxt = await fetchHtml(robotsTxtUrl);
      
      const sitemapMatch = robotsTxt.match(/Sitemap:\s*(.+)/i);
      if (sitemapMatch && sitemapMatch[1]) {
        return sitemapMatch[1].trim();
      }
    } catch (e) {
      console.log(`Could not fetch robots.txt for ${url}`, e);
    }

    // 2. Check common sitemap locations
    const commonLocations = [
      '/sitemap.xml',
      '/sitemap_index.xml',
      '/sitemap/sitemap.xml',
    ];

    for (const location of commonLocations) {
      const sitemapUrl = `${baseUrl}${location}`;
      try {
        const content = await fetchHtml(sitemapUrl);
        // Simple check if it looks like XML and contains sitemap tags
        if (content.includes('<?xml') && (content.includes('<urlset') || content.includes('<sitemapindex'))) {
          return sitemapUrl;
        }
      } catch (e) {
        // Ignore 404s etc
      }
    }

    return null;
  } catch (e) {
    console.error(`Error finding sitemap for ${url}`, e);
    return null;
  }
}

/**
 * Parses a sitemap XML and returns a list of URLs.
 * 
 * @param xml The sitemap XML content
 * @returns Array of URLs found in the sitemap
 */
export async function parseSitemap(xml: string): Promise<string[]> {
  if (!xml) return [];

  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: string[] = [];

  // Handle standard sitemaps
  $('url > loc').each((i, el) => {
    const url = $(el).text().trim();
    if (url) urls.push(url);
  });

  // Handle sitemap indexes (just returning the sitemap URLs themselves for now as per plan)
  $('sitemap > loc').each((i, el) => {
    const url = $(el).text().trim();
    if (url) urls.push(url);
  });

  return urls;
}
