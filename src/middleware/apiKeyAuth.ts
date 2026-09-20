import { NextRequest, NextResponse } from 'next/server';
import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';
import { recordTelemetry } from '@/lib/status/telemetry';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';

function positiveIntegerSetting(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizedForwardHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete('x-api-key-data');
  headers.delete('x-auth-user-id');
  headers.delete('x-auth-validated');
  headers.delete('x-required-scope');
  return headers;
}

export function requiredApiKeyScope(
  pathname: string,
  method: string,
): string | null {
  if (method === 'GET' && pathname.endsWith('/health')) return null;
  if (
    pathname.startsWith('/api/ai/')
    || pathname === '/api/analyze'
    || pathname.startsWith('/api/site/analyze')
    || pathname.startsWith('/api/site/tester')
    || /^\/api\/public\/(image|video|icon|summary)\/prompt\//.test(pathname)
  ) {
    return 'ai:generate';
  }
  return null;
}

export async function apiKeyAuth(req: NextRequest) {
  try {
    // CORS validation and authentication are independent. A browser Origin
    // never grants access to a private API route.
    let apiKey = req.headers.get('x-api-key');
    
    if (!apiKey) {
      const authHeader = req.headers.get('authorization');
      if (authHeader) {
        // Soportar formato "Bearer <apikey>" o directamente el apikey
        apiKey = authHeader.startsWith('Bearer ') 
          ? authHeader.substring(7) 
          : authHeader;
      }
    }

    if (!apiKey) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'API key is required for server-to-server requests'
          }
        },
        { status: 401 }
      );
    }

    // Primero verificar si es el SERVICE_API_KEY para servicios internos
    const serviceApiKey = process.env.SERVICE_API_KEY?.trim();
    if (serviceApiKey && apiKey === serviceApiKey) {
      const limited = await enforceRequestRateLimit(req, {
        namespace: 'service-api-key',
        identity: 'service-key',
        limit: positiveIntegerSetting(
          'SERVICE_API_KEY_REQUESTS_PER_MINUTE',
          5_000,
        ),
        windowSeconds: 60,
        failClosed: true,
      });
      if (limited) return limited;
      recordTelemetry('api_auth', 'up', 'Service API Key used', 5).catch(console.error);
      // API key de servicio válida, dar acceso completo
      const serviceKeyData = {
        id: 'service-key',
        name: 'Internal Service Key',
        scopes: ['*'], // Acceso completo
        isService: true
      };
      
      const requestHeaders = sanitizedForwardHeaders(req);
      requestHeaders.set('x-api-key-data', JSON.stringify(serviceKeyData));
      
      return NextResponse.next({
        request: {
          headers: requestHeaders,
        },
      });
    }

    // Si no es el SERVICE_API_KEY, validar contra la base de datos
    const startTime = Date.now();
    const { isValid, keyData } = await ApiKeyService.validateApiKey(apiKey);
    const latency = Date.now() - startTime;

    if (!isValid || !keyData) {
      recordTelemetry('api_auth', 'up', 'Invalid API key rejected', latency).catch(console.error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_API_KEY',
            message: 'Invalid or expired API key'
          }
        },
        { status: 401 }
      );
    }
    const principalLimited = await enforceRequestRateLimit(req, {
      namespace: 'api-key-principal',
      identity: keyData.id,
      limit: positiveIntegerSetting(
        'API_KEY_PRINCIPAL_REQUESTS_PER_MINUTE',
        600,
      ),
      windowSeconds: 60,
      failClosed: true,
    });
    if (principalLimited) return principalLimited;

    recordTelemetry('api_auth', 'up', 'Valid DB API key', latency).catch(console.error);
    const requiredScope = requiredApiKeyScope(
      req.nextUrl.pathname,
      req.method.toUpperCase(),
    );
    if (
      requiredScope
      && !keyData.scopes?.includes(requiredScope)
      && !keyData.scopes?.includes('*')
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INSUFFICIENT_SCOPE',
            message: `This operation requires the '${requiredScope}' scope`,
          },
        },
        { status: 403 },
      );
    }

    // Añadir información de la API key a la request para uso posterior
    const requestHeaders = sanitizedForwardHeaders(req);
    requestHeaders.set('x-api-key-data', JSON.stringify(keyData));
    
    return NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
  } catch (error) {
    console.error('[API Key Auth] Error in API key authentication:', error);
    recordTelemetry('api_auth', 'down', error instanceof Error ? error.message : 'Unknown error', 0).catch(console.error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'AUTH_ERROR',
          message: 'Error processing API key authentication'
        }
      },
      { status: 500 }
    );
  }
} 