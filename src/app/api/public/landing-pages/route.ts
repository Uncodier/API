import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getContents } from '@/lib/database/content-db';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    
    // Loguear los parámetros recibidos al inicio del request
    const allParams = Object.fromEntries(searchParams.entries());
    console.log('[API:public:landing-pages] Incoming request:', {
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
      console.log('[API:public:landing-pages] Resolving site context for ID:', { siteId });
      const { data: sites, error: siteError } = await supabaseAdmin
        .from('sites')
        .select('id, url, name')
        .eq('id', siteId)
        .limit(1);

      console.log('[API:public:landing-pages] Supabase search result for siteId:', { sites, siteError });

      if (siteError) {
        console.error('[API:public:landing-pages] Error querying site by ID:', siteError);
        return NextResponse.json({ error: 'Error validating site ID' }, { status: 500 });
      }

      if (!sites || sites.length === 0) {
        console.warn('[API:public:landing-pages] Site not found for the provided site_id:', { siteId });
        return NextResponse.json({ error: 'Site not found for the provided site_id' }, { status: 404 });
      }

      siteInfo = sites[0];
    } else if (siteUrl) {
      const hostnamesToTry = new Set<string>();

      const addHostnameVariants = (urlStr: string | null) => {
        if (!urlStr) return;
        try {
          const hn = !urlStr.startsWith('http') ? new URL(`https://${urlStr}`).hostname : new URL(urlStr).hostname;
          if (hn && hn !== 'localhost') {
            hostnamesToTry.add(hn);
            const parts = hn.split('.');
            if (parts.length > 2) {
              // Extract root domain to match against www. or base domains
              hostnamesToTry.add(parts.slice(-2).join('.'));
            }
          }
        } catch (e) {
          // Ignore
        }
      };

      addHostnameVariants(siteUrl);
      addHostnameVariants(request.headers.get('origin'));
      addHostnameVariants(request.headers.get('referer'));

      const hostnamesArray = Array.from(hostnamesToTry);
      console.log('[${apiName}] Resolving site context for URLs:', hostnamesArray);

      let sites: any[] | null = [];
      let siteError = null;

      if (hostnamesArray.length > 0) {
        const orFilter = hostnamesArray.map(h => `url.ilike.%${h}%`).join(',');
        
        const result = await supabaseAdmin
          .from('sites')
          .select('id, url, name')
          .or(orFilter)
          .limit(1);
          
        sites = result.data;
        siteError = result.error;
      }

      console.log('[${apiName}] Supabase search result for site:', { sites, siteError, hostnamesSearched: hostnamesArray });

      if (siteError) {
        console.error('[${apiName}] Error querying site by URL:', siteError);
        return NextResponse.json({ error: 'Error validating site URL' }, { status: 500 });
      }

      if (!sites || sites.length === 0) {
        console.warn('[${apiName}] Site not found for the provided URL:', { siteUrl, hostnamesSearched: hostnamesArray });
        return NextResponse.json({ error: 'Site not found for the provided URL' }, { status: 404 });
      }

      siteId = sites[0].id;
      siteInfo = sites[0];
    }

    if (!siteId || !siteInfo) {
      return NextResponse.json({ error: 'Could not resolve site context' }, { status: 400 });
    }

    // Get all public content items for this site
    // Assuming 'public' content items means status='published'
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? parseInt(limitParam, 10) : 100;
    
    // Filtros adicionales que pueden ser pasados
    const tagParam = searchParams.get('tag');
    const categoryParam = searchParams.get('category');
    const authorParam = searchParams.get('author');
    const searchParam = searchParams.get('search');
    
    console.log('[API:public:landing-pages] Fetching content with parameters:', {
      siteId,
      limit,
      tag: tagParam,
      category: categoryParam,
      author: authorParam,
      search: searchParam
    });

    const filterOptions: any = {
      site_id: siteId,
      type: 'landing_page',
      status: 'published',
      limit: limit > 0 ? limit : 100
    };

    if (searchParam) {
      filterOptions.search = searchParam;
    };
    
    // Si la función getContents soporta estos filtros, los añadimos
    // Por ahora los extraemos para saber qué están intentando filtrar

    const { contents, total } = await getContents(filterOptions);

    // Return the response allowing CORS if it's a public API
    const responseData: any = {
      success: true,
      data: contents,
      total,
      site: {
        id: siteInfo.id,
        name: siteInfo.name,
        url: siteInfo.url
      }
    };

    const response = NextResponse.json(responseData, { status: 200 });

    // Add CORS headers for a public API
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    return response;

  } catch (error: any) {
    console.error('[API:public:landing-pages] Error:', error);
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
