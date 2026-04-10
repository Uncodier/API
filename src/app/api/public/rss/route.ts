import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getContents } from '@/lib/database/content-db';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    // Loguear los parámetros recibidos al inicio del request
    const allParams = Object.fromEntries(searchParams.entries());
    console.log('[API:public:rss] Incoming request:', {
      params: {
        site_id: searchParams.get('site_id'),
        site_url: searchParams.get('site_url'),
        url: searchParams.get('url'),
        domain: searchParams.get('domain'),
        limit: searchParams.get('limit'),
        tag: searchParams.get('tag'),
        category: searchParams.get('category'),
        author: searchParams.get('author'),
        search: searchParams.get('search'),
        ...allParams // Añade cualquier otro parámetro no documentado que hayan enviado
      },
      headers: {
        origin: request.headers.get('origin'),
        referer: request.headers.get('referer'),
        hasAuthHeader: !!(request.headers.get('authorization') || request.headers.get('x-api-key') || request.headers.get('x-sa-api-key'))
      }
    });

    let siteUrl = searchParams.get('site_url') || searchParams.get('url') || searchParams.get('domain');

    if (!siteUrl) {
      const origin = request.headers.get('origin');
      const referer = request.headers.get('referer');
      
      if (origin) {
        siteUrl = origin;
      } else if (referer) {
        try {
          siteUrl = new URL(referer).origin;
        } catch {
          siteUrl = referer;
        }
      }
    }

    const hasAuth = !!(
      request.headers.get('authorization') || 
      request.headers.get('x-api-key') || 
      request.headers.get('x-sa-api-key')
    );

    let siteId = searchParams.get('site_id');

    // M2M o Request Público sin validación extra
    if (!siteUrl && !siteId && !hasAuth) {
      return NextResponse.json({ error: 'No site context provided (url or site_id), and no authorization token found' }, { status: 400 });
    }

    // Si viene autorización, verificar que venga site_id explícito o URL
    if (hasAuth) {
      // Si no hay URL ni site_id en una request M2M autenticada, fallar
      if (!siteUrl && !siteId) {
        return NextResponse.json({ error: 'M2M requests require either a site_url, url, or site_id parameter' }, { status: 400 });
      }
    }

    let siteInfo = null;

    if (siteId) {
      console.log('[API:public:rss] Resolving site context for ID:', { siteId });
      const { data: sites, error: siteError } = await supabaseAdmin
        .from('sites')
        .select('id, url, name, description')
        .eq('id', siteId)
        .limit(1);

      if (siteError) {
        console.error('[API:public:rss] Error querying site by ID:', siteError);
        return NextResponse.json({ error: 'Error validating site ID' }, { status: 500 });
      }

      if (!sites || sites.length === 0) {
        console.warn('[API:public:rss] Site not found for the provided site_id:', { siteId });
        return NextResponse.json({ error: 'Site not found for the provided site_id' }, { status: 404 });
      }

      siteInfo = sites[0];
    } else if (siteUrl) {
      let hostname = siteUrl;
      try {
        if (!siteUrl.startsWith('http')) {
          hostname = new URL(`https://${siteUrl}`).hostname;
        } else {
          hostname = new URL(siteUrl).hostname;
        }
      } catch (e) {
        // Fallback to the raw string if URL parsing fails
      }

      // Search for the site in the database
      const { data: sites, error: siteError } = await supabaseAdmin
        .from('sites')
        .select('id, url, name, description')
        .ilike('url', `%${hostname}%`)
        .limit(1);

      if (siteError) {
        console.error('[API:public:rss] Error querying site by URL:', siteError);
        return NextResponse.json({ error: 'Error validating site URL' }, { status: 500 });
      }

      if (!sites || sites.length === 0) {
        return NextResponse.json({ error: 'Site not found for the provided URL' }, { status: 404 });
      }

      siteId = sites[0].id;
      siteInfo = sites[0];
    }

    if (!siteId || !siteInfo) {
      return NextResponse.json({ error: 'Could not resolve site context' }, { status: 400 });
    }

    // Get all public blog posts for this site
    const { contents } = await getContents({
      site_id: siteId,
      type: 'blog_post',
      status: 'published',
      limit: 50 // Limitamos a los 50 más recientes para el feed RSS
    });

    const siteName = siteInfo?.name || 'Blog RSS Feed';
    const siteLink = siteInfo?.url || siteUrl || 'https://example.com';
    const siteDesc = siteInfo?.description || `Latest content from ${siteName}`;

    // Construir el XML del RSS feed manualmente
    let rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title><![CDATA[${siteName}]]></title>
    <link>${siteLink}</link>
    <description><![CDATA[${siteDesc}]]></description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
`;

    // Añadir cada artículo
    for (const item of contents) {
      const pubDate = item.published_at || item.created_at || new Date().toISOString();
      const link = (item as any).url || `${siteLink}/blog/${item.id}`; // Fallback URL, usando any temporalmente si DbContent no tiene url
      
      rssXml += `    <item>
      <title><![CDATA[${item.title}]]></title>
      <link>${link}</link>
      <guid isPermaLink="false">${item.id}</guid>
      <pubDate>${new Date(pubDate).toUTCString()}</pubDate>
      <description><![CDATA[${item.description || item.title}]]></description>
    </item>
`;
    }

    rssXml += `  </channel>
</rss>`;

    // Devolver XML response
    const response = new NextResponse(rssXml, {
      status: 200,
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600', // Cache 1 hora
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });

    return response;

  } catch (error: any) {
    console.error('[API:public:rss] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal Server Error', details: error.message },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  const response = new NextResponse(null, { status: 204 });
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return response;
}
