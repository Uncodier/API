import { NextRequest, NextResponse } from 'next/server';
import { deleteInbox } from '@/lib/integrations/agentmail/agentmail-service';

/**
 * DELETE handler for deleting AgentMail inboxes
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { inbox_id: string } }
) {
  try {
    const inbox_id = params.inbox_id;

    console.log(`📧 [AgentMail] Delete inbox request received for: ${inbox_id}`);

    // Validate inbox_id
    if (!inbox_id) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'inbox_id is required',
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

    // Delete inbox via AgentMail API
    console.log(`[AgentMail] Deleting inbox via AgentMail API: ${inbox_id}`);
    await deleteInbox(inbox_id);

    const response = {
      success: true,
      message: 'Inbox deleted successfully',
      inbox_id: inbox_id,
    };

    console.log(`[AgentMail] Inbox deleted successfully: ${inbox_id}`);

    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[AgentMail] Error deleting inbox:', error);

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
          message: error.message || 'Failed to delete inbox via AgentMail',
        },
      },
      { status: 500 }
    );
  }
}

