import { NextRequest } from 'next/server';
import { verifyEmail, EmailVerificationParams } from '@/lib/integrations/icypeas/icypeas-service';

/**
 * POST /api/integrations/icypeas/email-verification
 *
 * Verify an email address using Icypeas API
 *
 * Body:
 * {
 *   "email": "example-email@icypeas.com",
 *   "customobject": {
 *     "webhookUrl": "https://...",
 *     "externalId": "custom-id"
 *   }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, customobject } = body;

    // Validate required fields
    if (!email || typeof email !== 'string') {
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'MISSING_FIELD',
          message: 'email is required and must be a string',
        }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const params: EmailVerificationParams = {
      email,
      customobject,
    };

    console.log(`[Icypeas API] Verifying email: ${email}`);

    const result = await verifyEmail(params);

    return new Response(JSON.stringify({
      success: true,
      data: result
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Icypeas API] Error:', error);

    // Handle specific errors
    if (error.message.includes('ICYPEAS_API_KEY environment variable is not configured')) {
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'CONFIGURATION_ERROR',
          message: 'Icypeas API key is not configured',
        }
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (error.message.includes('Authentication failed')) {
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'AUTHENTICATION_ERROR',
          message: 'Authentication failed with Icypeas API',
        }
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (error.message.includes('Rate limit exceeded')) {
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Icypeas API rate limit exceeded',
        }
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message || 'An unexpected error occurred',
      }
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
