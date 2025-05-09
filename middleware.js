import { NextResponse } from 'next/server';

// Middleware simple con CORS
export default function middleware(request) {
  console.log('Middleware ejecutándose para:', request.nextUrl.pathname);
  
  // Obtener el origen de la solicitud
  const origin = request.headers.get('origin') || '*';
  console.log('Origen de la solicitud:', origin);

  // Para solicitudes preflight OPTIONS
  if (request.method === 'OPTIONS') {
    console.log('Procesando solicitud preflight OPTIONS');
    
    const response = new NextResponse(null, { status: 204 });
    
    // Agregar headers CORS con el origen de la solicitud
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin');
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Access-Control-Max-Age', '86400');
    response.headers.set('x-middleware-executed', 'true');
    
    return response;
  }
  
  // Para solicitudes normales
  const response = NextResponse.next();
  
  // Agregar headers CORS con el origen de la solicitud
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('x-middleware-executed', 'true');
  
  return response;
}

// Aplicar el middleware solo a rutas de API
export const config = {
  matcher: '/api/:path*',
}; 