import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import {
  checkDomainExists,
  createDomain,
  createInbox,
  CreateDomainParams,
  CreateInboxParams,
} from '@/lib/integrations/agentmail/agentmail-service';

/**
 * POST handler for creating AgentMail inbox with domain verification
 * Handles domain creation if needed, inbox creation, and updates settings.channels.agent_email
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📧 [AgentMail] Create inbox request received');

    const body = await request.json();

    // Extract parameters
    const {
      domain,
      username,
      displayName,
      siteId,
      siteName,
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

    if (!username) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'username is required',
          },
        },
        { status: 400 }
      );
    }

    if (!displayName) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'displayName is required',
          },
        },
        { status: 400 }
      );
    }

    if (!siteId) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'siteId is required',
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

    let domainId: string | null = null;
    let inboxId: string | null = null;
    let finalStatus: 'active' | 'requested' = 'active';
    let errorMessage: string | null = null;
    let requestedResource: 'domain' | 'inbox' | null = null;

    // Step 1: Check if domain exists
    console.log(`[AgentMail] Checking if domain exists: ${domain}`);
    let domainExists = false;
    try {
      domainExists = await checkDomainExists(domain);
    } catch (error: any) {
      console.error('[AgentMail] Error checking domain existence:', error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'DOMAIN_CHECK_ERROR',
            message: `Failed to check domain existence: ${error.message || 'Unknown error'}`,
          },
        },
        { status: 500 }
      );
    }

    // Step 2: Create domain if it doesn't exist
    if (!domainExists) {
      console.log(`[AgentMail] Domain does not exist, creating: ${domain}`);
      try {
        const domainParams: CreateDomainParams = {
          domain,
          feedback_enabled: true, // Default to true
        };

        const domainResponse = await createDomain(domainParams);
        domainId = domainResponse.domain_id;
        console.log(`[AgentMail] Domain created successfully: ${domainId}`);
      } catch (error: any) {
        console.error('[AgentMail] Error creating domain:', error);
        
        // Check if error indicates quota exceeded or similar
        const errorMsg = error.message || '';
        const isQuotaError = errorMsg.toLowerCase().includes('quota') ||
                            errorMsg.toLowerCase().includes('limit') ||
                            errorMsg.toLowerCase().includes('exceeded');

        if (isQuotaError) {
          console.log('[AgentMail] Domain creation quota error detected, setting status to requested');
          finalStatus = 'requested';
          errorMessage = errorMsg;
          requestedResource = 'domain';
        } else {
          // For other errors, return error response
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'DOMAIN_CREATION_ERROR',
                message: `Failed to create domain: ${errorMsg}`,
              },
            },
            { status: 500 }
          );
        }
      }
    } else {
      console.log(`[AgentMail] Domain already exists: ${domain}`);
      // Domain exists, we can continue with inbox creation
    }

    // Step 3: Create inbox (only if domain was created successfully or already existed)
    if (finalStatus !== 'requested' || requestedResource !== 'domain') {
      console.log(`[AgentMail] Creating inbox: ${username}@${domain}`);
      try {
        const inboxParams: CreateInboxParams = {
          username,
          domain,
          display_name: displayName,
          client_id: siteId, // Use siteId as client_id
        };

        const inboxResponse = await createInbox(inboxParams);
        inboxId = inboxResponse.inbox_id;
        console.log(`[AgentMail] Inbox created successfully: ${inboxId}`);
      } catch (error: any) {
        console.error('[AgentMail] Error creating inbox:', error);
        
        // Check if error indicates quota exceeded or similar
        const errorMsg = error.message || '';
        const isQuotaError = errorMsg.toLowerCase().includes('quota') ||
                            errorMsg.toLowerCase().includes('limit') ||
                            errorMsg.toLowerCase().includes('exceeded') ||
                            errorMsg.toLowerCase().includes('unavailable');

        if (isQuotaError) {
          console.log('[AgentMail] Inbox creation quota error detected, setting status to requested');
          finalStatus = 'requested';
          errorMessage = errorMsg;
          requestedResource = 'inbox';
        } else {
          // For other errors, return error response
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'INBOX_CREATION_ERROR',
                message: `Failed to create inbox: ${errorMsg}`,
              },
            },
            { status: 500 }
          );
        }
      }
    }

    // Step 4: Update settings.channels.agent_email
    console.log(`[AgentMail] Updating settings.channels.agent_email for site: ${siteId}`);
    try {
      // Get current settings
      const { data: settings, error: getError } = await supabaseAdmin
        .from('settings')
        .select('channels')
        .eq('site_id', siteId)
        .single();

      if (getError) {
        console.error('[AgentMail] Error getting settings:', getError);
        // Don't fail the request if settings update fails, but log it
        console.warn('[AgentMail] Continuing despite settings fetch error');
      } else {
        const currentChannels = settings?.channels || {};

        // Update agent_email channel
        const updatedChannels = {
          ...currentChannels,
          agent_email: {
            status: finalStatus,
            username,
            domain,
            display_name: displayName,
            ...(inboxId && { inbox_id: inboxId }),
            ...(domainId && { domain_id: domainId }),
            created_at: new Date().toISOString(),
            ...(errorMessage && { error_message: errorMessage }),
          },
        };

        // Update the settings
        const { error: updateError } = await supabaseAdmin
          .from('settings')
          .update({ channels: updatedChannels })
          .eq('site_id', siteId);

        if (updateError) {
          console.error('[AgentMail] Error updating settings:', updateError);
          // Don't fail the request if settings update fails, but log it
          console.warn('[AgentMail] Continuing despite settings update error');
        } else {
          console.log(`[AgentMail] Settings.channels.agent_email updated successfully`);
        }
      }
    } catch (error: any) {
      console.error('[AgentMail] Error updating settings:', error);
      // Don't fail the request if settings update fails, but log it
      console.warn('[AgentMail] Continuing despite settings update error');
    }

    // Step 5: Send notification if status is 'requested'
    if (finalStatus === 'requested' && errorMessage) {
      console.log(`[AgentMail] Sending notification for quota error`);
      try {
        await sendQuotaErrorNotification(siteId, errorMessage, requestedResource || 'unknown');
      } catch (notificationError) {
        console.error('[AgentMail] Error sending notification:', notificationError);
        // Don't fail the request if notification fails
      }
    }

    // Step 6: Return response
    const response: any = {
      success: true,
      status: finalStatus,
      message: finalStatus === 'active'
        ? 'Inbox and domain created successfully'
        : 'Request received but quota limit reached. Status set to requested.',
      ...(inboxId && { inbox_id: inboxId }),
      ...(domainId && { domain_id: domainId }),
    };

    if (finalStatus === 'requested') {
      response.error = {
        code: 'QUOTA_EXCEEDED',
        message: errorMessage,
        resource: requestedResource,
      };
    }

    console.log(`[AgentMail] Request completed with status: ${finalStatus}`);
    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[AgentMail] Error in create inbox endpoint:', error);

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

/**
 * Sends notification when quota error occurs
 */
async function sendQuotaErrorNotification(
  siteId: string,
  errorMessage: string,
  requestedResource: string
): Promise<void> {
  try {
    console.log(`[AgentMail] 📧 Sending quota error notification`);

    const notificationPayload = {
      site_id: siteId,
      error_type: requestedResource === 'domain' 
        ? 'agentmail_domain_quota_exceeded' 
        : 'agentmail_quota_exceeded',
      error_message: errorMessage,
      requested_resource: requestedResource,
      failure_timestamp: new Date().toISOString(),
      priority: 'high',
    };

    // Call the notification endpoint
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const notificationUrl = `${baseUrl}/api/notifications/agentmailQuotaError`;

    const response = await fetch(notificationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(notificationPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AgentMail] Failed to send notification:`, {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });
      return;
    }

    const result = await response.json();
    console.log(`[AgentMail] ✅ Quota error notification sent successfully:`, {
      success: result.success,
      notificationId: result.notification_id,
    });
  } catch (error) {
    console.error('[AgentMail] Error sending quota error notification:', error);
    throw error;
  }
}

