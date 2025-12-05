import { NextRequest, NextResponse } from 'next/server';
import { createInbox, CreateInboxParams } from '@/lib/integrations/agentmail/agentmail-service';

/**
 * POST handler for creating AgentMail inboxes
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📧 [AgentMail] Create inbox request received');

    const body = await request.json();

    // Extract parameters
    const {
      username,
      domain,
      display_name,
      client_id,
    } = body;

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
    const params: CreateInboxParams = {};

    if (username) {
      params.username = username;
    }
    if (domain) {
      params.domain = domain;
    }
    if (display_name) {
      params.display_name = display_name;
    }
    if (client_id) {
      params.client_id = client_id;
    }

    // Create inbox via AgentMail API
    console.log(`[AgentMail] Creating inbox via AgentMail API`);
    const agentmailResponse = await createInbox(params);

    const response = {
      success: true,
      ...agentmailResponse,
    };

    console.log(`[AgentMail] Inbox created successfully:`, {
      inbox_id: agentmailResponse.inbox_id,
      pod_id: agentmailResponse.pod_id,
    });

    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[AgentMail] Error creating inbox:', error);

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
          message: error.message || 'Failed to create inbox via AgentMail',
        },
      },
      { status: 500 }
    );
  }
}

