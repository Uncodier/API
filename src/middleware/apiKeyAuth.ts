import { NextRequest, NextResponse } from 'next/server';
import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';

export async function apiKeyAuth(req: NextRequest) {
  try {
    const apiKey = req.headers.get('x-api-key');

    if (!apiKey) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'API key is required'
          }
        },
        { status: 401 }
      );
    }

    const { isValid, keyData } = await ApiKeyService.validateApiKey(apiKey);

    if (!isValid) {
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

    // Verificar scopes si es necesario
    const requiredScope = req.headers.get('x-required-scope');
    if (requiredScope && !keyData.scopes.includes(requiredScope)) {
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
    
    return NextResponse.next();
  } catch (error) {
    console.error('Error in API key authentication:', error);
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