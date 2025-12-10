import { NextRequest, NextResponse } from 'next/server';
import { createDomain, CreateDomainParams } from '@/lib/integrations/agentmail/agentmail-service';

/**
 * POST handler for creating AgentMail domains
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📧 [AgentMail] Create domain request received');

    const body = await request.json();

    // Extract parameters
    const {
      domain,
      feedback_enabled,
    } = body;

    // Validate required parameters
    if (!domain) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'domain is required',
          },
        },
        { status: 400 }
      );
    }

    if (typeof feedback_enabled !== 'boolean') {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'feedback_enabled is required and must be a boolean',
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

    // Prepare AgentMail API parameters
    const params: CreateDomainParams = {
      domain,
      feedback_enabled,
    };

    // Create domain via AgentMail API
    console.log(`[AgentMail] Creating domain via AgentMail API: ${domain}`);
    const agentmailResponse = await createDomain(params);

    const response = {
      success: true,
      ...agentmailResponse,
    };

    console.log(`[AgentMail] Domain created successfully:`, {
      domain_id: agentmailResponse.domain_id,
      status: agentmailResponse.status,
    });

    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[AgentMail] Error creating domain:', error);

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
          message: error.message || 'Failed to create domain via AgentMail',
        },
      },
      { status: 500 }
    );
  }
}











