import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';
import { createSupabaseClient } from '@/lib/database/supabase-server';

// Schema para validar la creación de API keys
const CreateApiKeySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  scopes: z.array(z.string()).min(1, 'At least one scope is required'),
  site_id: z.string().uuid('Invalid site ID'),
  user_id: z.string().uuid('Invalid user ID'),
  expirationDays: z.number().optional().default(90),
  prefix: z.string().optional(),
  metadata: z.record(z.any()).optional()
});

export async function POST(request: NextRequest) {
  try {
    // Crear cliente de Supabase con el contexto apropiado
    const supabase = createSupabaseClient(request);
    
    console.log('[Keys API] POST request headers:', {
      origin: request.headers.get('origin') || 'NO_ORIGIN',
      hasAuth: !!request.headers.get('authorization'),
      hasApiKey: !!request.headers.get('x-api-key-data'),
    });

    // Validar request body
    const body = await request.json();
    const validationResult = CreateApiKeySchema.safeParse(body);
    
    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid request parameters',
            details: validationResult.error.format()
          }
        },
        { status: 400 }
      );
    }

    // Verificar ENCRYPTION_KEY
    if (!process.env.ENCRYPTION_KEY) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'CONFIGURATION_ERROR',
            message: 'Server configuration error - encryption key not set'
          }
        },
        { status: 500 }
      );
    }

    // Verificar que el usuario tiene acceso al sitio
    console.log('[Keys API] Checking site access:', {
      site_id: validationResult.data.site_id,
      user_id: validationResult.data.user_id,
    });

    const { data: siteAccess, error: siteError } = await supabase
      .from('sites')
      .select('id')
      .eq('id', validationResult.data.site_id)
      .eq('user_id', validationResult.data.user_id)
      .single();

    console.log('[Keys API] Site access check result:', {
      hasAccess: !!siteAccess,
      error: siteError?.message || null
    });

    if (siteError || !siteAccess) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'You do not have access to this site',
            details: process.env.NODE_ENV === 'development' ? siteError?.message : undefined
          }
        },
        { status: 403 }
      );
    }

    try {
      const apiKeyData = await ApiKeyService.createApiKey(
        validationResult.data.user_id,
        validationResult.data
      );

      return NextResponse.json({
        success: true,
        data: apiKeyData
      });
    } catch (error) {
      console.error('[Keys API] Error creating API key:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        hasEncryptionKey: !!process.env.ENCRYPTION_KEY
      });
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SYSTEM_ERROR',
            message: error instanceof Error ? error.message : 'Error creating API key'
          }
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('[Keys API] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'SYSTEM_ERROR',
          message: error instanceof Error ? error.message : 'Error processing request'
        }
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    // Crear cliente de Supabase con el contexto apropiado
    const supabase = createSupabaseClient(request);
    
    console.log('[Keys API] GET request headers:', {
      origin: request.headers.get('origin') || 'NO_ORIGIN',
      hasAuth: !!request.headers.get('authorization'),
      hasApiKey: !!request.headers.get('x-api-key-data'),
    });

    // Obtener user_id y site_id de los query params
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const siteId = searchParams.get('site_id');

    if (!userId || !siteId) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'user_id and site_id are required'
          }
        },
        { status: 400 }
      );
    }

    try {
      // Verificar que el usuario tiene acceso al sitio
      const { data: siteAccess, error: siteError } = await supabase
        .from('sites')
        .select('id')
        .eq('id', siteId)
        .eq('user_id', userId)
        .single();

      if (siteError || !siteAccess) {
        console.log('[Keys API] Access denied:', {
          error: siteError?.message,
          siteId,
          userId
        });
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: 'You do not have access to this site',
              details: process.env.NODE_ENV === 'development' ? siteError?.message : undefined
            }
          },
          { status: 403 }
        );
      }

      // Listar API keys del usuario para el sitio
      const apiKeys = await ApiKeyService.listApiKeys(userId, siteId);

      return NextResponse.json({
        success: true,
        data: apiKeys
      });
    } catch (error) {
      console.error('[Keys API] Error listing API keys:', error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SYSTEM_ERROR',
            message: error instanceof Error ? error.message : 'Error listing API keys'
          }
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('[Keys API] Error in request:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'SYSTEM_ERROR',
          message: error instanceof Error ? error.message : 'Error processing request'
        }
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Crear cliente de Supabase con el contexto apropiado
    const supabase = createSupabaseClient(request);
    
    console.log('[Keys API] DELETE request headers:', {
      origin: request.headers.get('origin') || 'NO_ORIGIN',
      hasAuth: !!request.headers.get('authorization'),
      hasApiKey: !!request.headers.get('x-api-key-data'),
    });

    // Obtener parámetros
    const { searchParams } = new URL(request.url);
    const keyId = searchParams.get('id');
    const siteId = searchParams.get('site_id');
    const userId = searchParams.get('user_id');

    if (!keyId || !siteId || !userId) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'API key ID, site_id and user_id are required'
          }
        },
        { status: 400 }
      );
    }

    try {
      // Verificar que el usuario tiene acceso al sitio
      const { data: siteAccess, error: siteError } = await supabase
        .from('sites')
        .select('id')
        .eq('id', siteId)
        .eq('user_id', userId)
        .single();

      if (siteError || !siteAccess) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: 'You do not have access to this site'
            }
          },
          { status: 403 }
        );
      }

      // Revocar API key
      const success = await ApiKeyService.revokeApiKey(userId, keyId, siteId);

      if (!success) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: 'API key not found or already revoked'
            }
          },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        message: 'API key revoked successfully'
      });
    } catch (error) {
      console.error('[Keys API] Error revoking API key:', error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SYSTEM_ERROR',
            message: error instanceof Error ? error.message : 'Error revoking API key'
          }
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('[Keys API] Error in request:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'SYSTEM_ERROR',
          message: error instanceof Error ? error.message : 'Error processing request'
        }
      },
      { status: 500 }
    );
  }
} 