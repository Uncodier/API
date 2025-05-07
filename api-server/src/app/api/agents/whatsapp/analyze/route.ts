import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { CommandValidator } from '@/lib/validators/CommandValidator';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

// Define validation schema for the request
const AnalyzeWhatsAppMessagesSchema = z.object({
  messageIds: z.array(z.string()).min(1, 'At least one message ID is required'),
  agentId: z.string().uuid('Invalid agent ID format'),
  site_id: z.string().uuid('Invalid site ID format'),
  team_member_id: z.string().uuid('Invalid team member ID format').optional(),
  analysis_type: z.string().optional(),
  lead_id: z.string().uuid('Invalid lead ID format').optional(),
  conversation_id: z.string().uuid('Invalid conversation ID format').optional(),
  phone_number: z.string().optional(),
});

/**
 * API endpoint to analyze WhatsApp messages using AI agents
 */
export async function POST(request: NextRequest) {
  try {
    // Parse the request body
    const body = await request.json();
    
    // Validate the request against the schema
    const validationResult = AnalyzeWhatsAppMessagesSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ Invalid request parameters:', validationResult.error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid request parameters',
            details: validationResult.error.format(),
          },
        },
        { status: 400 }
      );
    }
    
    const {
      messageIds,
      agentId,
      site_id,
      team_member_id,
      analysis_type,
      lead_id,
      conversation_id,
      phone_number,
    } = validationResult.data;
    
    // Verify agent exists
    const { data: agent, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('id, name, type')
      .eq('id', agentId)
      .single();
    
    if (agentError || !agent) {
      console.error('❌ Agent not found:', agentError);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: 'The specified agent does not exist',
          },
        },
        { status: 404 }
      );
    }
    
    // Verify messages exist
    const { data: messages, error: messagesError } = await supabaseAdmin
      .from('messages')
      .select('id, content, created_at, sender_type, visitor_id, custom_data')
      .in('id', messageIds);
    
    if (messagesError) {
      console.error('❌ Error retrieving messages:', messagesError);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SYSTEM_ERROR',
            message: 'Error retrieving messages',
          },
        },
        { status: 500 }
      );
    }
    
    if (!messages || messages.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'MESSAGE_NOT_FOUND',
            message: 'One or more specified messages do not exist',
          },
        },
        { status: 404 }
      );
    }
    
    // Verify team member if provided
    if (team_member_id) {
      const { data: teamMember, error: teamMemberError } = await supabaseAdmin
        .from('team_members')
        .select('id')
        .eq('id', team_member_id)
        .single();
      
      if (teamMemberError || !teamMember) {
        console.error('❌ Team member not found:', teamMemberError);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'USER_NOT_FOUND',
              message: 'The specified team member does not exist',
            },
          },
          { status: 404 }
        );
      }
    }
    
    // Create a command object for the analysis task
    const commandId = `cmd_${uuidv4()}`;
    const phoneNumberValue = phone_number || 
      (messages[0]?.custom_data?.whatsapp_phone as string) || 
      'unknown';
    
    // Create the command structure
    const commandData = {
      id: commandId,
      agent_id: agentId,
      site_id,
      team_member_id: team_member_id || null,
      status: 'pending',
      task_type: 'whatsapp_analysis',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      priority: 'normal',
      data: {
        message_ids: messageIds,
        analysis_type: analysis_type || 'comprehensive',
        lead_id: lead_id || null,
        conversation_id: conversation_id || null,
        phone_number: phoneNumberValue,
      },
      targets: [
        {
          analysis: {
            summary: '',
            insights: [],
            sentiment: '',
            priority: '',
            action_items: [],
            response_suggestions: [],
          }
        }
      ],
      tools: [
        {
          name: 'whatsapp_message_extraction',
          description: 'extract content and metadata from WhatsApp messages',
          status: 'not_initialized',
          type: 'synchronous',
          parameters: {
            type: 'object',
            properties: {
              message_ids: {
                type: 'array',
                description: 'The IDs of the WhatsApp messages to extract data from',
                items: {
                  type: 'string'
                }
              },
              extract_media: {
                type: 'boolean',
                description: 'Whether to extract media contents (images, audio, video, etc.)'
              }
            },
            required: ['message_ids']
          }
        },
        {
          name: 'sentiment_analysis',
          description: 'analyze sentiment of message content',
          status: 'not_initialized',
          type: 'synchronous',
          parameters: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The text content to analyze for sentiment'
              },
              detailed: {
                type: 'boolean',
                description: 'Whether to return detailed sentiment breakdown'
              }
            },
            required: ['text']
          }
        },
        {
          name: 'knowledge_base_search',
          description: 'search knowledge base for relevant information',
          status: 'not_initialized',
          type: 'synchronous',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query for knowledge base'
              },
              site_id: {
                type: 'string',
                description: 'The site ID for the knowledge base'
              }
            },
            required: ['query', 'site_id']
          }
        },
        {
          name: 'contact_information_lookup',
          description: 'lookup contact information from phone number',
          status: 'not_initialized',
          type: 'synchronous',
          parameters: {
            type: 'object',
            properties: {
              phone_number: {
                type: 'string',
                description: 'The phone number to look up'
              },
              site_id: {
                type: 'string',
                description: 'The site ID for the contact database'
              }
            },
            required: ['phone_number', 'site_id']
          }
        }
      ],
      context: `WhatsApp messages for analysis. ${messages.length} messages from phone ${phoneNumberValue}`,
      supervisors: [
        {
          agent_role: 'customer_service_specialist',
          status: 'not_initialized'
        },
        {
          agent_role: 'sales_manager',
          status: 'not_initialized'
        }
      ],
      task: 'analyze whatsapp messages',
      description: 'Analyze the provided WhatsApp messages to extract key insights, determine sentiment, identify action items, and suggest appropriate responses based on message content and context.'
    };
    
    // Validate the command structure
    const commandValidation = CommandValidator.safeParse(commandData);
    
    if (!commandValidation.success) {
      console.error('❌ Invalid command structure:', commandValidation.error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SYSTEM_ERROR',
            message: 'Error creating command',
            details: commandValidation.error.format(),
          },
        },
        { status: 500 }
      );
    }
    
    // Store the command in the database
    const { error: commandError } = await supabaseAdmin
      .from('commands')
      .insert([commandData]);
    
    if (commandError) {
      console.error('❌ Error storing command:', commandError);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SYSTEM_ERROR',
            message: 'Error storing command',
          },
        },
        { status: 500 }
      );
    }
    
    // Start command processing in the background
    // In a real implementation, you would likely have a queue or worker system
    // to process these commands asynchronously
    
    // Return success response with command ID
    return NextResponse.json(
      {
        success: true,
        data: {
          commandId,
          status: 'processing',
          message: 'Command created successfully'
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('❌ Unexpected error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'SYSTEM_ERROR',
          message: 'Internal server error',
        },
      },
      { status: 500 }
    );
  }
} 