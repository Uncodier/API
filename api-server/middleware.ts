import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAllowedOrigins, getAllowedHeaders, isOriginAllowed } from './cors.config.js';

/**
 * Middleware CORS completo
 */
export function middleware(request: NextRequest) {
  const isDevMode = process.env.NODE_ENV !== 'production';
  console.log(`[CORS] Middleware ejecutándose: ${request.method} ${request.nextUrl.pathname} (${isDevMode ? 'DEV' : 'PROD'})`);
  
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
    
    // Si el origen es permitido o estamos en desarrollo, establecer encabezados específicos
    if (origin && (originAllowed || isDevMode)) {
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
  
  // En desarrollo, permitir todos los orígenes
  if (isDevMode && origin) {
    console.log('[CORS] Modo desarrollo: permitiendo origen:', origin);
    const response = NextResponse.next();
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', getAllowedHeaders());
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Vary', 'Origin');
    return response;
  }
  
  // Rechazar si el origen no está permitido (solo en producción)
  if (origin && !originAllowed && !isDevMode) {
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
  if (origin && (originAllowed || isDevMode)) {
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