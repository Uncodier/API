import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAllowedOrigins, getAllowedHeaders, isOriginAllowed } from './cors.config.js';

/**
 * Middleware CORS completo
 */
export function middleware(request: NextRequest) {
  console.log('[CORS] Middleware ejecutándose:', request.method, request.nextUrl.pathname);
  
  // Obtener el origen
  const origin = request.headers.get('origin');
  console.log('[CORS] Origen:', origin);
  
  // Verificar si el origen está permitido
  const originAllowed = isOriginAllowed(origin);
  console.log('[CORS] Origen permitido:', originAllowed);
  
  // Para solicitudes preflight OPTIONS
  if (request.method === 'OPTIONS') {
    console.log('[CORS] Procesando preflight');
    
    const response = new NextResponse(null, { status: 204 });
    
    // Establecer encabezados CORS
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', getAllowedHeaders());
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Max-Age', '86400');
    
    // Si el origen es permitido, establecer encabezados específicos
    if (origin && originAllowed) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Credentials', 'true');
      console.log('[CORS] Preflight aceptado para:', origin);
    } else if (origin) {
      console.log('[CORS] Preflight rechazado para:', origin);
      return new NextResponse(null, {
        status: 403,
        statusText: 'Forbidden - Origin not allowed'
      });
    }
    
    return response;
  }
  
  // Rechazar si el origen no está permitido
  if (origin && !originAllowed) {
    console.log('[CORS] Solicitud rechazada para:', origin);
    return new NextResponse(null, {
      status: 403,
      statusText: 'Forbidden - Origin not allowed'
    });
  }
  
  // Para solicitudes normales
  const response = NextResponse.next();
  
  // Añadir encabezado Vary para controlar caché
  response.headers.set('Vary', 'Origin');
  
  // Si hay un origen y está permitido, añadir encabezados CORS
  if (origin && originAllowed) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', getAllowedHeaders());
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    console.log('[CORS] Encabezados añadidos para:', origin);
  }
  
  return response;
}

// Aplicar el middleware solo a rutas de API
export const config = {
  matcher: ['/api/:path*'],
}; 