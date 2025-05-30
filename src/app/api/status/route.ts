import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * Health check endpoint
 * GET /api/status
 * 
 * Retorna información sobre el estado del servidor y servicios
 */
export async function GET(request: NextRequest) {
  try {
    const startTime = Date.now();
    
    // Información básica del servidor
    const serverInfo = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      nodeVersion: process.version,
    };

    // Headers relevantes
    const headers: Record<string, string | null> = {
      origin: request.headers.get('origin'),
      'x-api-key': request.headers.get('x-api-key'),
      authorization: request.headers.get('authorization'),
      'user-agent': request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      host: request.headers.get('host'),
      'x-middleware-executed': request.headers.get('x-middleware-executed'),
      'x-api-key-data': request.headers.get('x-api-key-data'),
    };

    // Información de autenticación
    const authInfo: any = {
      origin: headers.origin || 'none',
      hasApiKey: !!(headers['x-api-key'] || headers.authorization),
      authMethod: 'none',
      headers: {
        origin: headers.origin ? 'PRESENT' : 'ABSENT',
        'x-api-key': headers['x-api-key'] ? 'PRESENT' : 'ABSENT',
        authorization: headers.authorization ? 'PRESENT' : 'ABSENT',
      },
      rawHeaders: process.env.NODE_ENV === 'development' ? headers : undefined,
    };

    // Determinar método de autenticación
    if (authInfo.origin !== 'none') {
      authInfo.authMethod = 'CORS';
    } else if (authInfo.hasApiKey) {
      authInfo.authMethod = 'API_KEY';
      
      // Si hay datos de API key en los headers (añadidos por el middleware)
      const apiKeyData = headers['x-api-key-data'];
      if (apiKeyData) {
        try {
          const keyData = JSON.parse(apiKeyData);
          authInfo.apiKeyInfo = {
            id: keyData.id,
            name: keyData.name,
            scopes: keyData.scopes,
            isService: keyData.isService || false,
          };
        } catch (e) {
          authInfo.apiKeyDataError = 'Failed to parse API key data';
        }
      }
    }

    // Log detallado para debugging
    console.log('[Status Endpoint] Request details:', {
      url: request.url,
      method: request.method,
      origin: headers.origin || 'NO_ORIGIN',
      authMethod: authInfo.authMethod,
      hasApiKey: authInfo.hasApiKey,
      middlewareExecuted: headers['x-middleware-executed'] || 'NO',
    });

    // Verificar conexión a Supabase
    const databaseStatus = await checkDatabaseConnection();

    // Verificar variables de entorno críticas
    const envCheck = {
      hasSupabaseUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      hasSupabaseKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      hasEncryptionKey: !!process.env.ENCRYPTION_KEY,
      hasServiceApiKey: !!process.env.SERVICE_API_KEY,
    };

    // Calcular tiempo de respuesta
    const responseTime = Date.now() - startTime;

    // Determinar estado general
    const isHealthy = databaseStatus.connected && 
                     envCheck.hasSupabaseUrl && 
                     envCheck.hasSupabaseKey;

    const response = {
      success: true,
      server: {
        ...serverInfo,
        status: isHealthy ? 'healthy' : 'degraded',
        responseTimeMs: responseTime,
      },
      authentication: authInfo,
      services: {
        database: databaseStatus,
      },
      environment: envCheck,
      middleware: {
        executed: headers['x-middleware-executed'] === 'true',
      },
    };

    return NextResponse.json(response, {
      status: isHealthy ? 200 : 503,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Response-Time': `${responseTime}ms`,
      },
    });
  } catch (error) {
    console.error('[Status Endpoint] Error:', error);
    
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'STATUS_CHECK_ERROR',
          message: 'Error checking server status',
          details: process.env.NODE_ENV === 'development' 
            ? (error instanceof Error ? error.message : String(error)) 
            : undefined,
        },
      },
      { status: 500 }
    );
  }
}

/**
 * Verificar conexión a la base de datos
 */
async function checkDatabaseConnection() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return {
        connected: false,
        error: 'Missing database configuration',
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Hacer una consulta simple para verificar la conexión
    const { data, error } = await supabase
      .from('sites')
      .select('id')
      .limit(1);

    if (error) {
      return {
        connected: false,
        error: error.message,
      };
    }

    return {
      connected: true,
      responseTime: 'OK',
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
} 