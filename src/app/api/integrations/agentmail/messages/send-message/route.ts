import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { sendMessage, SendMessageParams } from '@/lib/integrations/agentmail/agentmail-service';

/**
 * POST handler for sending messages via AgentMail
 * Compatible with sendEmail tool parameters
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📧 [AgentMail] Send message request received');

    const body = await request.json();

    // Extract parameters (support both sendEmail and AgentMail formats)
    const {
      // Recipient (support both 'email' and 'to')
      email,
      to,
      // Content
      subject,
      message,
      text,
      html,
      // Optional fields
      from,
      reply_to,
      cc,
      bcc,
      attachments,
      headers,
      labels,
      // Optional AgentMail specific (if not provided, will be obtained from site settings)
      inbox_id,
      site_id,
      // Optional context
      agent_id,
      conversation_id,
      lead_id,
    } = body;

    // Validate required parameters
    const recipient = to || email;
    if (!recipient) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Either "to" or "email" parameter is required',
          },
        },
        { status: 400 }
      );
    }

    if (!subject) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'subject is required',
          },
        },
        { status: 400 }
      );
    }

    const messageContent = text || message || html;
    if (!messageContent) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Either "message", "text", or "html" parameter is required',
          },
        },
        { status: 400 }
      );
    }

    if (!site_id) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'site_id is required',
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

    // Get site settings to determine inbox_id from agent_email channel
    let effectiveInboxId = inbox_id;
    
    if (!effectiveInboxId) {
      console.log(`[AgentMail] inbox_id not provided, obtaining from site settings for site_id: ${site_id}`);
      
      const { data: siteSettings, error: settingsError } = await supabaseAdmin
        .from('settings')
        .select('channels')
        .eq('site_id', site_id)
        .single();

      if (settingsError || !siteSettings) {
        console.error('[AgentMail] Error getting site settings:', settingsError);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'SITE_CONFIG_NOT_FOUND',
              message: 'Site configuration not found or agent_email channel not configured',
            },
          },
          { status: 404 }
        );
      }

      const agentEmailConfig = siteSettings.channels?.agent_email;
      
      if (!agentEmailConfig) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'AGENT_EMAIL_NOT_CONFIGURED',
              message: 'agent_email channel is not configured for this site',
            },
          },
          { status: 400 }
        );
      }

      if (agentEmailConfig.status !== 'active') {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'AGENT_EMAIL_NOT_ACTIVE',
              message: 'agent_email channel is not active for this site',
            },
          },
          { status: 400 }
        );
      }

      // Construct inbox_id from username@domain
      const username = agentEmailConfig.username || agentEmailConfig.data?.username;
      const domain = agentEmailConfig.domain || agentEmailConfig.data?.domain;

      if (!username || !domain) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'INVALID_AGENT_EMAIL_CONFIG',
              message: 'agent_email configuration is missing username or domain',
            },
          },
          { status: 400 }
        );
      }

      effectiveInboxId = `${username}@${domain}`;
      console.log(`[AgentMail] Inbox ID determined from settings: ${effectiveInboxId}`);
    }

    // Prepare AgentMail API parameters
    const agentmailParams: SendMessageParams = {
      to: Array.isArray(recipient) ? recipient : [recipient],
      subject,
    };

    // Add text or html content
    if (text || message) {
      agentmailParams.text = text || message;
    }
    if (html) {
      agentmailParams.html = html;
    }

    // Add optional fields
    if (reply_to) {
      agentmailParams.reply_to = reply_to;
    }
    if (cc) {
      agentmailParams.cc = cc;
    }
    if (bcc) {
      agentmailParams.bcc = bcc;
    }
    if (attachments && Array.isArray(attachments)) {
      agentmailParams.attachments = attachments;
    }
    if (headers && typeof headers === 'object') {
      agentmailParams.headers = headers;
    }
    if (labels && Array.isArray(labels)) {
      agentmailParams.labels = labels;
    }

    // Send message via AgentMail API
    console.log(`[AgentMail] Sending message via AgentMail API to inbox: ${effectiveInboxId}`);
    const agentmailResponse = await sendMessage(effectiveInboxId, agentmailParams);

    // Determine recipient email for response (use first if array)
    const recipientEmail = Array.isArray(recipient) ? recipient[0] : recipient;

    // Determine sender email (could be from site settings, but for now use a placeholder)
    // In a real implementation, you might want to get this from site settings
    const senderEmail = from || 'noreply@agentmail.to';

    // Save message to database if conversation_id is provided
    let savedMessageId: string | null = null;
    if (conversation_id) {
      try {
        // Verify conversation exists
        const { data: conversation, error: convError } = await supabaseAdmin
          .from('conversations')
          .select('id, site_id, lead_id')
          .eq('id', conversation_id)
          .single();

        if (convError || !conversation) {
          console.warn(`[AgentMail] Conversation ${conversation_id} not found, skipping message save`);
        } else {
          // Prepare message data with AgentMail metadata
          const messageData: any = {
            conversation_id: conversation_id,
            content: messageContent,
            role: 'assistant', // Messages sent via API are from the assistant/agent
            site_id: site_id || conversation.site_id,
            lead_id: lead_id || conversation.lead_id,
            agent_id: agent_id,
            custom_data: {
              status: 'sent',
              agentmail_message_id: agentmailResponse.message_id,
              agentmail_thread_id: agentmailResponse.thread_id,
              agentmail_inbox_id: effectiveInboxId,
              delivery: {
                channel: 'agentmail',
                details: {
                  channel: 'agentmail',
                  recipient: recipientEmail,
                  subject: subject,
                  timestamp: new Date().toISOString(),
                  api_messageId: agentmailResponse.message_id, // For webhook lookup
                },
                success: true,
                timestamp: new Date().toISOString(),
              },
              from: senderEmail,
              to: recipientEmail,
              subject: subject,
              content_extracted: true,
              sync_source: 'agentmail_api',
            },
          };

          // Insert message
          const { data: savedMessage, error: msgError } = await supabaseAdmin
            .from('messages')
            .insert([messageData])
            .select()
            .single();

          if (msgError) {
            console.error('[AgentMail] Error saving message to database:', msgError);
            // Don't fail the request if message save fails, just log it
          } else {
            savedMessageId = savedMessage.id;
            console.log(`[AgentMail] Message saved to database: ${savedMessageId}`);

            // Update conversation last_message_at
            await supabaseAdmin
              .from('conversations')
              .update({
                last_message_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq('id', conversation_id);
          }
        }
      } catch (dbError: any) {
        console.error('[AgentMail] Error saving message to database:', dbError);
        // Don't fail the request if message save fails
      }
    } else {
      // Even without conversation_id, we might want to save the message
      // For now, we'll skip it, but this could be extended
      console.log('[AgentMail] No conversation_id provided, skipping message save to database');
    }

    // Return response compatible with sendEmail tool
    const response = {
      success: true,
      status: 'sent',
      message_id: agentmailResponse.message_id,
      thread_id: agentmailResponse.thread_id,
      recipient: recipientEmail,
      sender: senderEmail,
      subject: subject,
      sent_at: new Date().toISOString(),
      ...(savedMessageId && { db_message_id: savedMessageId }),
    };

    console.log(`[AgentMail] Message sent successfully:`, {
      message_id: agentmailResponse.message_id,
      thread_id: agentmailResponse.thread_id,
      recipient: recipientEmail,
    });

    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[AgentMail] Error sending message:', error);

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

    if (error.message?.includes('Message Rejected')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'MESSAGE_REJECTED',
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
          message: error.message || 'Failed to send message via AgentMail',
        },
      },
      { status: 500 }
    );
  }
}

