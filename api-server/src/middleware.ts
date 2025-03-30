import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  try {
    // Enhanced logging with more details for debugging
    console.log('==== MIDDLEWARE EXECUTION START ====');
    console.log(`[MIDDLEWARE] Request: ${request.method} ${request.nextUrl.pathname}`);
    console.log(`[MIDDLEWARE] Origin: ${request.headers.get('origin') || 'unknown'}`);
    console.log(`[MIDDLEWARE] Source IP: ${request.ip || request.headers.get('x-forwarded-for') || 'unknown'}`);
    console.log(`[MIDDLEWARE] User-Agent: ${request.headers.get('user-agent') || 'unknown'}`);
    
    // Get the origin from the request
    const origin = request.headers.get('origin');
    console.log(`[MIDDLEWARE] Request Origin: ${origin || 'Not provided'}`);
    
    // Normalize the URL to handle potential double slashes
    const pathname = request.nextUrl.pathname.replace(/\/+/g, '/');
    console.log(`[MIDDLEWARE] Normalized path: ${pathname}`);
    
    // Check if the request is for the visitors/session endpoint (handle both session and sessions)
    const isVisitorsSessionRoute = pathname.includes('/api/visitors/session') || 
                                  pathname.includes('/api/visitors/sessions') ||
                                  pathname.includes('/api/visitors/cors-test');
    
    console.log(`[MIDDLEWARE] Is visitors route: ${isVisitorsSessionRoute}`);
    
    // For OPTIONS requests, handle CORS immediately regardless of URL format
    if (request.method === 'OPTIONS' && isVisitorsSessionRoute) {
      console.log(`[MIDDLEWARE] Handling OPTIONS request for visitors path: ${pathname}`);
      const response = new NextResponse(null, { status: 204 });
      
      // If it's a credentialed request and has an origin, we must reflect that origin instead of using *
      if (origin) {
        console.log(`[MIDDLEWARE] Using specific origin for CORS: ${origin}`);
        response.headers.set('Access-Control-Allow-Origin', origin);
        response.headers.set('Access-Control-Allow-Credentials', 'true');
      } else {
        console.log('[MIDDLEWARE] No origin provided, using wildcard');
        response.headers.set('Access-Control-Allow-Origin', '*');
      }
      
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin, X-Requested-With');
      
      console.log('[MIDDLEWARE] Returning OPTIONS response with CORS headers');
      console.log('==== MIDDLEWARE EXECUTION COMPLETE ====');
      return response;
    }
    
    // If we detect a URL that needs correction (double slashes or sessions instead of session)
    if (isVisitorsSessionRoute) {
      // Check if we need to redirect (double slash or plural sessions)
      const hasDoubleSlash = request.nextUrl.pathname.includes('//');
      const hasSessionsPlural = pathname.includes('/api/visitors/sessions');
      
      if (hasDoubleSlash || hasSessionsPlural) {
        console.log(`[MIDDLEWARE] URL needs correction: doubleSlash=${hasDoubleSlash}, plural=${hasSessionsPlural}`);
        
        // Fix the URL - normalize double slashes and ensure singular 'session'
        let correctedPath = pathname;
        if (hasSessionsPlural) {
          correctedPath = correctedPath.replace('/sessions', '/session');
        }
        
        // Create redirect URL with the same query parameters
        const redirectUrl = new URL(correctedPath, request.url);
        // Copy any query parameters
        request.nextUrl.searchParams.forEach((value, key) => {
          redirectUrl.searchParams.set(key, value);
        });
        
        console.log(`[MIDDLEWARE] Redirecting to: ${redirectUrl.toString()}`);
        
        const redirectResponse = NextResponse.redirect(redirectUrl, 301);
        
        // Add CORS headers to the redirect - reflect the specific origin if provided
        if (origin) {
          redirectResponse.headers.set('Access-Control-Allow-Origin', origin);
          redirectResponse.headers.set('Access-Control-Allow-Credentials', 'true');
        } else {
          redirectResponse.headers.set('Access-Control-Allow-Origin', '*');
        }
        
        redirectResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        redirectResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin, X-Requested-With');
        
        console.log('==== MIDDLEWARE EXECUTION COMPLETE - REDIRECT ====');
        return redirectResponse;
      }
    }
    
    // Handle OPTIONS request for preflight checks (for non-session routes)
    if (request.method === 'OPTIONS') {
      console.log(`[MIDDLEWARE] Handling OPTIONS request for non-visitors route: ${pathname}`);
      const response = new NextResponse(null, { status: 204 });
      
      // Original CORS for other routes
      response.headers.set('Access-Control-Allow-Origin', 'http://localhost:3000');
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-api-secret');
      response.headers.set('Access-Control-Allow-Credentials', 'true');
      
      console.log('==== MIDDLEWARE EXECUTION COMPLETE ====');
      return response;
    }

    // For non-OPTIONS requests
    console.log(`[MIDDLEWARE] Proceeding with regular ${request.method} request`);
    const response = NextResponse.next();

    // Add the CORS headers to the response
    if (isVisitorsSessionRoute) {
      // Open CORS for visitors/session route - reflect the specific origin if provided
      console.log('[MIDDLEWARE] Adding CORS headers for visitors route');
      
      if (origin) {
        console.log(`[MIDDLEWARE] Using specific origin for CORS: ${origin}`);
        response.headers.set('Access-Control-Allow-Origin', origin);
        response.headers.set('Access-Control-Allow-Credentials', 'true');
      } else {
        console.log('[MIDDLEWARE] No origin provided, using wildcard');
        response.headers.set('Access-Control-Allow-Origin', '*');
      }
      
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin, X-Requested-With');
    } else {
      // Original CORS for other routes
      console.log('[MIDDLEWARE] Adding standard CORS headers for other route');
      response.headers.set('Access-Control-Allow-Origin', 'http://localhost:3000');
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-api-secret');
      response.headers.set('Access-Control-Allow-Credentials', 'true');
    }

    console.log('==== MIDDLEWARE EXECUTION COMPLETE ====');
    return response;
  } catch (error) {
    console.error(`[MIDDLEWARE ERROR] ${error instanceof Error ? error.message : 'Unknown error'}`);
    console.error('[MIDDLEWARE ERROR] Stack:', error instanceof Error ? error.stack : 'No stack available');
    
    // In case of error, use the origin-specific approach for safety
    const errorResponse = NextResponse.next();
    const origin = request.headers.get('origin');
    
    if (origin) {
      errorResponse.headers.set('Access-Control-Allow-Origin', origin);
      errorResponse.headers.set('Access-Control-Allow-Credentials', 'true');
    } else {
      errorResponse.headers.set('Access-Control-Allow-Origin', '*');
    }
    
    errorResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    errorResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin, X-Requested-With');
    
    console.log('==== MIDDLEWARE EXECUTION COMPLETE WITH ERROR ====');
    return errorResponse;
  }
}

// Update matcher to specifically include the visitors endpoints
export const config = {
  matcher: [
    '/api/:path*',
    '/api/visitors/session',
    '/api/visitors/session/:path*',
    '/api/visitors/sessions',
    '/api/visitors/sessions/:path*',
    '/api/visitors/cors-test'
  ],
}; 