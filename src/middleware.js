/**
 * MIDDLEWARE CORS PARA PRODUCCIÓN (VERCEL)
 * 
 * IMPORTANTE: Este archivo está duplicado intencionalmente.
 * - Este archivo (en /src) es usado por Vercel en producción
 * - El archivo en /middleware.js es usado por Next.js en desarrollo local
 * 
 * NO ELIMINAR NINGUNO DE LOS DOS ARCHIVOS
 * Ambos son necesarios para que el CORS funcione correctamente en todos los entornos.
 */

import { NextResponse } from 'next/server';
import { getAllowedOrigins, getAllowedHeaders, isOriginAllowed } from '../cors.config.js';
import { apiKeyAuth } from './middleware/apiKeyAuth';

/**
 * Middleware CORS completo
 * Este se ejecuta como una Edge Function
 */
export default async function middleware(request) {
  const isDevMode = process.env.NODE_ENV !== 'production';
  
  // Obtener el origen
  const origin = request.headers.get('origin');
  
  console.log('[Middleware] Request details:', {
    url: request.url,
    method: request.method,
    origin: origin || 'NO_ORIGIN',
    isDevMode,
    headers: {
      'x-api-key': request.headers.get('x-api-key') ? 'PRESENT' : 'ABSENT',
      'authorization': request.headers.get('authorization') ? 'PRESENT' : 'ABSENT',
      'user-agent': request.headers.get('user-agent'),
    }
  });
  
  // Verificar si el origen está permitido
  const allowedOrigins = getAllowedOrigins();
  
  const originAllowed = await isOriginAllowed(origin);
  
  console.log('[Middleware] Origin check:', {
    origin,
    originAllowed,
    allowedOrigins: isDevMode ? 'ALL (dev mode)' : allowedOrigins
  });
  
  // Para solicitudes preflight OPTIONS
  if (request.method === 'OPTIONS') {
    console.log('[Middleware] Handling OPTIONS preflight request');
    const response = new NextResponse(null, { status: 204 });
    
    // Establecer encabezados CORS
    const allowedHeaders = getAllowedHeaders();
    
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', allowedHeaders);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Max-Age', '86400');
    response.headers.set('X-Middleware-Executed', 'true');
    
    // Si el origen es permitido o estamos en desarrollo, establecer encabezados específicos
    if (origin && (originAllowed || isDevMode)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Credentials', 'true');
      console.log('[Middleware] OPTIONS: Origin allowed');
    } else if (origin) {
      console.log('[Middleware] OPTIONS: Origin rejected');
      return new NextResponse(null, {
        status: 403,
        statusText: 'Forbidden - Origin not allowed'
      });
    }
    
    return response;
  }
  
  // Si no hay origin (petición machine-to-machine), validar API key
  if (!origin) {
    console.log('[Middleware] No origin detected - checking API key');
    const apiKeyResponse = await apiKeyAuth(request);
    // Si el middleware retorna algo diferente a NextResponse.next(), es un error
    if (apiKeyResponse.status && apiKeyResponse.status !== 200) {
      console.log('[Middleware] API key validation failed');
      return apiKeyResponse;
    }
    console.log('[Middleware] API key validation passed');
  }
  
  // En desarrollo, permitir todos los orígenes
  if (isDevMode && origin) {
    console.log('[Middleware] Dev mode with origin - allowing all origins');
    const response = NextResponse.next();
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', getAllowedHeaders());
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Vary', 'Origin');
    response.headers.set('X-Middleware-Executed', 'true');
    
    return response;
  }
  
  // Rechazar si el origen no está permitido (solo en producción)
  if (origin && !originAllowed && !isDevMode) {
    console.log('[Middleware] Origin not allowed in production');
    return new NextResponse(null, {
      status: 403,
      statusText: 'Forbidden - Origin not allowed'
    });
  }
  
  // Para solicitudes normales
  const response = NextResponse.next();
  
  // Añadir encabezado Vary para controlar caché
  response.headers.set('Vary', 'Origin');
  response.headers.set('X-Middleware-Executed', 'true');
  
  // Si hay un origen y está permitido, añadir encabezados CORS
  if (origin && (originAllowed || isDevMode)) {
    console.log('[Middleware] Setting CORS headers for allowed origin');
    // IMPORTANTE: Nunca usar el comodín cuando hay credenciales
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', getAllowedHeaders());
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  } else {
    console.log('[Middleware] No CORS headers set:', {
      hasOrigin: !!origin,
      originAllowed,
      isDevMode
    });
  }
  
  console.log('[Middleware] Request processing complete');
  return response;
}

// Aplicar el middleware solo a rutas de API
export const config = {
  matcher: ['/api/:path*'],
}; 