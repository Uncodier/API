import { NextRequest } from 'next/server';
import NeverBounce from 'neverbounce';

// Inicializar cliente de NeverBounce
const client = new NeverBounce({
  apiKey: process.env.NEVER_BOUNCE_API_KEY!
});

/**
 * POST /api/integrations/neverbounce/validate
 * 
 * Valida si una dirección de email es válida usando NeverBounce
 * 
 * Body:
 * {
 *   "email": "email@example.com"
 * }
 * 
 * Response:
 * {
 *   "email": "email@example.com",
 *   "isValid": true,
 *   "result": "valid",
 *   "flags": [],
 *   "suggested_correction": null,
 *   "execution_time": 123
 * }
 */
export async function POST(request: NextRequest) {
  try {
    // Verificar que la API key esté configurada
    if (!process.env.NEVER_BOUNCE_API_KEY) {
      console.error('NEVER_BOUNCE_API_KEY environment variable is not set');
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'API_KEY_NOT_CONFIGURED',
          message: 'NeverBounce API key not configured',
          details: 'Contact administrator to configure email validation service'
        }
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Parsear el body de la request
    const body = await request.json();
    const { email } = body;

    // Validar que se proporcionó un email
    if (!email) {
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'EMAIL_REQUIRED',
          message: 'Email is required',
          details: 'Please provide an email address to validate'
        }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validar formato básico de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          email,
          isValid: false,
          result: 'invalid',
          flags: ['invalid_format'],
          suggested_correction: null,
          execution_time: 0,
          message: 'Invalid email format',
          timestamp: new Date().toISOString()
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`Validating email: ${email}`);
    
    // Verificar el email con NeverBounce
    const startTime = Date.now();
    const result = await client.single.check(email);
    const executionTime = Date.now() - startTime;

    console.log(`NeverBounce result for ${email}:`, result);

    // Obtener la respuesta completa del resultado
    const responseData = result.getResponse();
    
    // Determinar si el email es válido usando el método is()
    const isValid = result.is('valid');
    
    // Obtener el resultado usando el método getResult()
    const validationResult = result.getResult();
    
    // Mapear flags si existen en la respuesta
    const flags = responseData.flags || [];
    
    // Obtener sugerencia de corrección si existe en la respuesta
    const suggestedCorrection = responseData.suggested_correction || null;

    // Respuesta estructurada siguiendo el patrón del proyecto
    const response = {
      success: true,
      data: {
        email,
        isValid,
        result: validationResult,
        flags,
        suggested_correction: suggestedCorrection,
        execution_time: executionTime,
        message: isValid ? 'Email is valid' : `Email is ${validationResult}`,
        timestamp: new Date().toISOString()
      }
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Error validating email with NeverBounce:', error);

    // Manejar errores específicos de NeverBounce
    if (error.type === 'auth_failure') {
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'AUTH_FAILURE',
          message: 'Authentication failed',
          details: 'Invalid NeverBounce API key'
        }
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (error.type === 'quota_exceeded') {
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'QUOTA_EXCEEDED',
          message: 'Quota exceeded',
          details: 'NeverBounce API quota has been exceeded'
        }
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (error.type === 'temp_unavail') {
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service temporarily unavailable',
          details: 'NeverBounce service is temporarily unavailable'
        }
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Error genérico
    return new Response(JSON.stringify({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred while validating the email'
      }
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * GET /api/integrations/neverbounce/validate
 * 
 * Información sobre el endpoint de validación
 */
export async function GET() {
  return new Response(JSON.stringify({
    success: true,
    data: {
      service: 'NeverBounce Email Validation',
      version: '1.0.0',
      description: 'Validate email addresses using NeverBounce API',
      endpoints: {
        validate: {
          method: 'POST',
          path: '/api/integrations/neverbounce/validate',
          description: 'Validate a single email address',
          body: {
            email: 'string (required) - Email address to validate'
          },
          response: {
            success: 'boolean - Operation success status',
            data: {
              email: 'string - The validated email',
              isValid: 'boolean - Whether the email is valid',
              result: 'string - NeverBounce result (valid, invalid, disposable, catchall, unknown)',
              flags: 'array - Additional flags from NeverBounce',
              suggested_correction: 'string|null - Suggested correction if available',
              execution_time: 'number - Time taken to validate in milliseconds',
              message: 'string - Human readable message',
              timestamp: 'string - ISO timestamp of validation'
            }
          }
        }
      },
      status: process.env.NEVER_BOUNCE_API_KEY ? 'configured' : 'not_configured',
      timestamp: new Date().toISOString()
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}