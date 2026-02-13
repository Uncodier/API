import { NextRequest } from 'next/server';
import { searchEmail, EmailSearchParams } from '@/lib/integrations/icypeas/icypeas-service';

/**
 * POST /api/integrations/icypeas/email-search
 * 
 * Search for an email address using Icypeas API
 * 
 * Body:
 * {
 *   "firstname": "John",
 *   "lastname": "Doe",
 *   "domainOrCompany": "icypeas.com",
 *   "customobject": { ... }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { firstname, lastname, domainOrCompany, customobject } = body;

    // Validate required fields
    if (!domainOrCompany) {
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'MISSING_FIELD',
          message: 'domainOrCompany is required',
        }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!firstname && !lastname) {
      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'MISSING_FIELD',
          message: 'Either firstname or lastname is required',
        }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const params: EmailSearchParams = {
      firstname,
      lastname,
      domainOrCompany,
      customobject,
    };

    console.log(`[Icypeas API] Searching email for ${firstname} ${lastname} at ${domainOrCompany}`);

    const result = await searchEmail(params);

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
