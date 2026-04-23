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
  
  // Check if it's a WhatsApp webhook route (they have their own Twilio validation)
  const wpWebhookPaths = [
    '/api/agents/whatsapp',
    '/api/agents/gear/whatsapp/webhook',
    '/api/integrations/whatsapp/webhook'
  ];
  
  const isWhatsAppWebhook = wpWebhookPaths.includes(request.nextUrl.pathname);
  
  // Verificar si es el webhook de Stripe (tiene su propia validación de firma)
  const isStripeWebhook = request.nextUrl.pathname === '/api/integrations/stripe/webhook';
  
  // Verificar si es un webhook de AgentMail (tiene su propia validación de Svix)
  const isAgentMailWebhook = request.nextUrl.pathname.startsWith('/api/integrations/agentmail/webhook/');

  // Outstand webhooks: HMAC signature validated in route (OUTSTAND_WEBHOOK_SECRET)
  const isOutstandWebhook =
    request.nextUrl.pathname === '/api/integrations/outstand/webhooks';

  // Vercel webhook: secret validated in route (VERCEL_WEBHOOK_SECRET)
  const isVercelWebhook =
    request.nextUrl.pathname === '/api/integrations/vercel/webhook';

  // Verificar si es una ruta pública explícita
  const isPublicRoute = request.nextUrl.pathname.startsWith('/api/public/');
  
  // Obtener el origen
  const origin = request.headers.get('origin');
  
  console.log('[Middleware] Request details:', {
    url: request.url,
    method: request.method,
    origin: origin || 'NO_ORIGIN',
    isDevMode,
    isWhatsAppWebhook,
    isStripeWebhook,
    isAgentMailWebhook,
    isOutstandWebhook,
    isVercelWebhook,
    headers: {
      'x-api-key': request.headers.get('x-api-key') ? 'PRESENT' : 'ABSENT',
      'authorization': request.headers.get('authorization') ? 'PRESENT' : 'ABSENT',
      'user-agent': request.headers.get('user-agent'),
    }
  });
  
  // Para WhatsApp webhook, permitir sin validación (Twilio valida en la ruta)
  if (isWhatsAppWebhook) {
    console.log('[Middleware] WhatsApp webhook detected - skipping origin/API validation');
    const response = NextResponse.next();
    response.headers.set('X-Middleware-Executed', 'true');
    response.headers.set('X-WhatsApp-Webhook', 'true');
    return response;
  }
  
  // Para Stripe webhook, permitir sin validación (Stripe valida con firma)
  if (isStripeWebhook) {
    console.log('[Middleware] Stripe webhook detected - skipping origin/API validation');
    const response = NextResponse.next();
    response.headers.set('X-Middleware-Executed', 'true');
    response.headers.set('X-Stripe-Webhook', 'true');
    return response;
  }
  
  // Para AgentMail webhooks, permitir sin validación (Svix valida con firma)
  if (isAgentMailWebhook) {
    console.log('[Middleware] AgentMail webhook detected - skipping origin/API validation');
    const response = NextResponse.next();
    response.headers.set('X-Middleware-Executed', 'true');
    response.headers.set('X-AgentMail-Webhook', 'true');
    return response;
  }

  // Para Outstand webhooks, permitir sin API key (firma HMAC en la ruta)
  if (isOutstandWebhook) {
    console.log('[Middleware] Outstand webhook detected - skipping origin/API validation');
    const response = NextResponse.next();
    response.headers.set('X-Middleware-Executed', 'true');
    response.headers.set('X-Outstand-Webhook', 'true');
    return response;
  }

  // Para Vercel webhook, permitir sin API key (secret validado en la ruta)
  if (isVercelWebhook) {
    console.log('[Middleware] Vercel webhook detected - skipping origin/API validation');
    const response = NextResponse.next();
    response.headers.set('X-Middleware-Executed', 'true');
    response.headers.set('X-Vercel-Webhook', 'true');
    return response;
  }

  // Para rutas públicas explícitas (/api/public/*), aplicar lógica específica
  if (isPublicRoute) {
    console.log('[Middleware] Public route detected - validating access');
    
    // Si viene de un navegador, verificar si el origen está permitido
    if (origin) {
      const isOriginAllowedCheck = await isOriginAllowed(origin);
      if (isOriginAllowedCheck || isDevMode) {
        console.log('[Middleware] Public route accessed from allowed origin');
        const response = NextResponse.next();
        response.headers.set('X-Middleware-Executed', 'true');
        response.headers.set('X-Public-Route', 'true');
        
        response.headers.set('Access-Control-Allow-Origin', origin);
        response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return response;
      } else {
        console.log('[Middleware] Public route accessed from UNALLOWED origin');
        return new NextResponse(null, {
          status: 403,
          statusText: 'Forbidden - Origin not allowed for public API'
        });
      }
    } 
    // Si no hay origen (M2M) o si es origin no permitido, debe tener API key
    else {
      console.log('[Middleware] Public route accessed without origin (M2M) - checking API key');
      const apiKeyResponse = await apiKeyAuth(request);
      if (apiKeyResponse.status && apiKeyResponse.status !== 200) {
        console.log('[Middleware] Public route API key validation failed');
        return apiKeyResponse;
      }
      
      console.log('[Middleware] Public route API key validation passed');
      const response = NextResponse.next();
      response.headers.set('X-Middleware-Executed', 'true');
      response.headers.set('X-Public-Route-Authenticated', 'true');
      return response;
    }
  }
  
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
    // En desarrollo local, permitir requests sin API key si vienen de localhost
    const isLocalhost = request.url.includes('localhost') || request.url.includes('127.0.0.1') || request.url.includes('0.0.0.0');
    
    if (isDevMode && isLocalhost) {
      console.log('[Middleware] Localhost request in dev mode - skipping API key validation');
    } else {
      console.log('[Middleware] No origin detected - checking API key');
      const apiKeyResponse = await apiKeyAuth(request);
      // Si el middleware retorna algo diferente a NextResponse.next(), es un error
      if (apiKeyResponse.status && apiKeyResponse.status !== 200) {
        console.log('[Middleware] API key validation failed');
        return apiKeyResponse;
      }
      console.log('[Middleware] API key validation passed');
    }
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