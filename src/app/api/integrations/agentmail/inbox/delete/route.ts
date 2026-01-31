import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { deleteInbox } from '@/lib/integrations/agentmail/agentmail-service';

/**
 * DELETE handler for deleting AgentMail inbox
 * Deletes the inbox via AgentMail API and updates settings.channels.agent_email
 */
export async function DELETE(request: NextRequest) {
  try {
    console.log('📧 [AgentMail] Delete inbox request received');

    const body = await request.json();

    // Extract parameters
    const {
      inbox_id,
      siteId,
    } = body;

    // Validate required parameters
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

    // Step 1: Delete inbox via AgentMail API
    console.log(`[AgentMail] Deleting inbox via AgentMail API: ${inbox_id}`);
    try {
      await deleteInbox(inbox_id);
      console.log(`[AgentMail] Inbox deleted successfully: ${inbox_id}`);
    } catch (error: any) {
      console.error('[AgentMail] Error deleting inbox:', error);
      
      const errorMsg = error.message || '';
      
      // Check if error is due to inbox not found
      const isNotFound = errorMsg.toLowerCase().includes('not found') ||
                        errorMsg.toLowerCase().includes('404');

      if (isNotFound) {
        console.log('[AgentMail] Inbox not found, continuing with settings cleanup');
        // Continue with settings cleanup even if inbox doesn't exist
      } else {
        // For other errors, return error response
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'INBOX_DELETION_ERROR',
              message: `Failed to delete inbox: ${errorMsg}`,
            },
          },
          { status: 500 }
        );
      }
    }

    // Step 2: Update settings.channels.agent_email
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

        // Remove or clear agent_email channel
        const updatedChannels = {
          ...currentChannels,
          agent_email: null,
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
          console.log(`[AgentMail] Settings.channels.agent_email cleared successfully`);
        }
      }
    } catch (error: any) {
      console.error('[AgentMail] Error updating settings:', error);
      // Don't fail the request if settings update fails, but log it
      console.warn('[AgentMail] Continuing despite settings update error');
    }

    // Step 3: Return response
    const response = {
      success: true,
      message: 'Inbox deleted successfully',
      inbox_id: inbox_id,
    };

    console.log(`[AgentMail] Request completed successfully`);
    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[AgentMail] Error in delete inbox endpoint:', error);

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
          message: error.message || 'Failed to delete inbox via AgentMail',
        },
      },
      { status: 500 }
    );
  }
}
