import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAllowedOrigins, getAllowedHeaders, isOriginAllowed } from './cors.config.js';

/**
 * Middleware CORS completo
 */
export function middleware(request: NextRequest) {
  const isDevMode = process.env.NODE_ENV !== 'production';
  console.log(`[CORS-DEBUG] Middleware ejecutándose: ${request.method} ${request.nextUrl.pathname} (${isDevMode ? 'DEV' : 'PROD'})`);
  console.log(`[CORS-DEBUG] NODE_ENV=${process.env.NODE_ENV}`);
  
  // Obtener el origen
  const origin = request.headers.get('origin');
  console.log('[CORS-DEBUG] Origen recibido:', origin);
  
  // Verificar si el origen está permitido
  const allowedOrigins = getAllowedOrigins();
  console.log('[CORS-DEBUG] Orígenes permitidos:', allowedOrigins);
  
  const originAllowed = isOriginAllowed(origin);
  console.log('[CORS-DEBUG] Origen permitido:', originAllowed, 'Modo desarrollo:', isDevMode);
  
  // Para solicitudes preflight OPTIONS
  if (request.method === 'OPTIONS') {
    console.log('[CORS-DEBUG] Procesando preflight');
    
    const response = new NextResponse(null, { status: 204 });
    
    // Establecer encabezados CORS
    const allowedHeaders = getAllowedHeaders();
    console.log('[CORS-DEBUG] Headers permitidos:', allowedHeaders);
    
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', allowedHeaders);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Max-Age', '86400');
    response.headers.set('X-Middleware-Executed', 'true');
    
    // Si el origen es permitido o estamos en desarrollo, establecer encabezados específicos
    if (origin && (originAllowed || isDevMode)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Credentials', 'true');
      console.log('[CORS-DEBUG] Preflight aceptado para:', origin);
      
      // Convertir headers a objeto para logging
      const headerObj: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headerObj[key] = value;
      });
      console.log('[CORS-DEBUG] Headers de respuesta:', headerObj);
    } else if (origin) {
      console.log('[CORS-DEBUG] Preflight rechazado para:', origin);
      return new NextResponse(null, {
        status: 403,
        statusText: 'Forbidden - Origin not allowed'
      });
    }
    
    return response;
  }
  
  // En desarrollo, permitir todos los orígenes
  if (isDevMode && origin) {
    console.log('[CORS-DEBUG] Modo desarrollo: permitiendo origen:', origin);
    const response = NextResponse.next();
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', getAllowedHeaders());
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Vary', 'Origin');
    response.headers.set('X-Middleware-Executed', 'true');
    
    // Convertir headers a objeto para logging
    const headerObj: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headerObj[key] = value;
    });
    console.log('[CORS-DEBUG] Headers de respuesta desarrollo:', headerObj);
    return response;
  }
  
  // Rechazar si el origen no está permitido (solo en producción)
  if (origin && !originAllowed && !isDevMode) {
    console.log('[CORS-DEBUG] Solicitud rechazada para:', origin);
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
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', getAllowedHeaders());
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    console.log('[CORS-DEBUG] Encabezados añadidos para:', origin);
    
    // Convertir headers a objeto para logging
    const headerObj: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headerObj[key] = value;
    });
    console.log('[CORS-DEBUG] Headers de respuesta normal:', headerObj);
  }
  
  return response;
}

// Aplicar el middleware solo a rutas de API
export const config = {
  matcher: ['/api/:path*'],
}; 