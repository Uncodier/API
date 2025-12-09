import { NextRequest, NextResponse } from 'next/server';
import { verifyDomain } from '@/lib/integrations/agentmail/agentmail-service';

/**
 * POST handler for verifying AgentMail domains
 */
export async function POST(
  request: NextRequest,
  props: { params: Promise<{ domain_id: string }> }
) {
  try {
    const params = await props.params;
    const domain_id = params.domain_id;

    console.log(`📧 [AgentMail] Verify domain request received for: ${domain_id}`);

    // Validate domain_id
    if (!domain_id) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'domain_id is required',
          },
        },
        { status: 400 }
      );
    }

    // Check if AGENTMAIL_API_KEY is configured
    if (!process.env.AGENTMAIL_API_KEY) {
      console.error('[AgentMail] AGENTMAIL_API_KEY not configured');
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'CONFIGURATION_ERROR',
            message: 'AgentMail API key is not configured',
          },
        },
        { status: 500 }
      );
    }

    // Verify domain via AgentMail API
    console.log(`[AgentMail] Verifying domain via AgentMail API: ${domain_id}`);
    const verifyResponse = await verifyDomain(domain_id);

    const response = {
      success: true,
      message: 'Domain verification initiated successfully',
      ...verifyResponse,
    };

    console.log(`[AgentMail] Domain verification completed:`, {
      domain_id: verifyResponse.domain_id,
      status: verifyResponse.status,
    });

    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[AgentMail] Error verifying domain:', error);

    // Handle specific error types
    if (error.message?.includes('AGENTMAIL_API_KEY')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'CONFIGURATION_ERROR',
            message: error.message,
          },
        },
        { status: 500 }
      );
    }

    if (error.message?.includes('Validation Error')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: error.message,
          },
        },
        { status: 400 }
      );
    }

    if (error.message?.includes('Forbidden')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: error.message,
          },
        },
        { status: 403 }
      );
    }

    if (error.message?.includes('Not Found')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: error.message,
          },
        },
        { status: 404 }
      );
    }

    // Generic error
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: error.message || 'Failed to verify domain via AgentMail',
        },
      },
      { status: 500 }
    );
  }
}
