import { NextRequest, NextResponse } from 'next/server';
import { getContents } from '@/lib/database/content-db';
import {
  hasExplicitPublicSiteContext,
  resolvePublicSiteContext,
} from '@/lib/security/public-site-context';

function xmlText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET(request: NextRequest) {
  try {
    const site = await resolvePublicSiteContext(request);
    if (!site) {
      return NextResponse.json(
        { success: false, error: 'Site not found' },
        { status: 404 },
      );
    }
    const { contents } = await getContents({
      site_id: site.id,
      type: 'blog_post',
      status: 'published',
      limit: 50,
      exact_count: false,
      public_projection: true,
    });
    const siteName = site.name || 'Blog RSS Feed';
    const siteLink = site.url || 'https://example.com';
    const siteDescription = site.description || `Latest content from ${siteName}`;
    const items = contents.map((item) => {
      const publishedAt = item.published_at || item.created_at;
      const directUrl = (item as unknown as { url?: unknown }).url;
      const itemUrl = typeof directUrl === 'string'
        ? directUrl
        : typeof item.metadata?.url === 'string'
          ? item.metadata.url
        : `${siteLink.replace(/\/$/, '')}/blog/${item.id}`;
      return `    <item>
      <title>${xmlText(item.title)}</title>
      <link>${xmlText(itemUrl)}</link>
      <guid isPermaLink="false">${xmlText(item.id)}</guid>
      <pubDate>${new Date(publishedAt).toUTCString()}</pubDate>
      <description>${xmlText(item.description || item.title)}</description>
    </item>`;
    }).join('\n');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlText(siteName)}</title>
    <link>${xmlText(siteLink)}</link>
    <description>${xmlText(siteDescription)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': hasExplicitPublicSiteContext(request)
          ? 'public, s-maxage=3600, stale-while-revalidate=3600'
          : 'private, no-store',
      },
    });
  } catch (error) {
    console.error('[Public RSS] Request failed:', error);
    return NextResponse.json(
      { success: false, error: 'Internal Server Error' },
      { status: 500 },
    );
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
