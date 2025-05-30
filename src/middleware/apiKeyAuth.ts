import { NextRequest, NextResponse } from 'next/server';
import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';

export async function apiKeyAuth(req: NextRequest) {
  try {
    // Validar API keys cuando no hay origin (peticiones machine-to-machine)
    // tanto en desarrollo como en producción
    const origin = req.headers.get('origin');
    const isProduction = process.env.NODE_ENV === 'production';
    
    console.log('[API Key Auth] Request details:', {
      url: req.url,
      method: req.method,
      origin: origin || 'NO_ORIGIN',
      isProduction,
      headers: {
        'x-api-key': req.headers.get('x-api-key') ? 'PRESENT' : 'ABSENT',
        'authorization': req.headers.get('authorization') ? 'PRESENT' : 'ABSENT',
      }
    });
    
    // Si hay origin (viene de un navegador), continuar sin validar API key
    if (origin) {
      console.log('[API Key Auth] Skipping API key validation:', {
        reason: 'Has origin (browser request)',
        origin
      });
      return NextResponse.next();
    }

    console.log('[API Key Auth] Processing server-to-server request (no origin)');

    // Obtener API key de x-api-key o authorization header
    let apiKey = req.headers.get('x-api-key');
    
    if (!apiKey) {
      const authHeader = req.headers.get('authorization');
      if (authHeader) {
        // Soportar formato "Bearer <apikey>" o directamente el apikey
        apiKey = authHeader.startsWith('Bearer ') 
          ? authHeader.substring(7) 
          : authHeader;
        console.log('[API Key Auth] Using Authorization header');
      }
    } else {
      console.log('[API Key Auth] Using x-api-key header');
    }

    if (!apiKey) {
      console.log('[API Key Auth] No API key found in headers');
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
    const serviceApiKey = process.env.SERVICE_API_KEY;
    if (serviceApiKey && apiKey === serviceApiKey) {
      console.log('[API Key Auth] Valid SERVICE_API_KEY detected');
      // API key de servicio válida, dar acceso completo
      const serviceKeyData = {
        id: 'service-key',
        name: 'Internal Service Key',
        scopes: ['*'], // Acceso completo
        isService: true
      };
      
      req.headers.set('x-api-key-data', JSON.stringify(serviceKeyData));
      return NextResponse.next();
    }

    console.log('[API Key Auth] Validating API key against database');
    // Si no es el SERVICE_API_KEY, validar contra la base de datos
    const { isValid, keyData } = await ApiKeyService.validateApiKey(apiKey);

    if (!isValid) {
      console.log('[API Key Auth] Invalid API key');
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

    console.log('[API Key Auth] Valid API key:', {
      id: keyData.id,
      name: keyData.name,
      scopes: keyData.scopes
    });

    // Verificar scopes si es necesario
    const requiredScope = req.headers.get('x-required-scope');
    if (requiredScope && keyData.scopes && !keyData.scopes.includes(requiredScope) && !keyData.scopes.includes('*')) {
      console.log('[API Key Auth] Insufficient scope:', {
        required: requiredScope,
        available: keyData.scopes
      });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INSUFFICIENT_SCOPE',
            message: `This operation requires the '${requiredScope}' scope`
          }
        },
        { status: 403 }
      );
    }

    // Añadir información de la API key a la request para uso posterior
    req.headers.set('x-api-key-data', JSON.stringify(keyData));
    
    console.log('[API Key Auth] API key validation successful');
    return NextResponse.next();
  } catch (error) {
    console.error('[API Key Auth] Error in API key authentication:', error);
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