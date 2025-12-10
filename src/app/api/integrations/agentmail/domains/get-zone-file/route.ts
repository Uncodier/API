import { NextRequest, NextResponse } from 'next/server';
import { getZoneFile } from '@/lib/integrations/agentmail/agentmail-service';

/**
 * GET handler for getting AgentMail domain zone file
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const domain_id = searchParams.get('domain_id');

    console.log(`📧 [AgentMail] Get zone file request received for domain: ${domain_id}`);

    // Validate domain_id
    if (!domain_id) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'domain_id query parameter is required',
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

    // Get zone file via AgentMail API
    console.log(`[AgentMail] Getting zone file via AgentMail API for domain: ${domain_id}`);
    const zoneFileContent = await getZoneFile(domain_id);

    // Return zone file as text/plain
    return new NextResponse(zoneFileContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  } catch (error: any) {
    console.error('[AgentMail] Error getting zone file:', error);

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
          message: error.message || 'Failed to get zone file via AgentMail',
        },
      },
      { status: 500 }
    );
  }
}











