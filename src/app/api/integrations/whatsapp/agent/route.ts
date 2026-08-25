import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';

export const maxDuration = 300;

// Initialize the agent processor
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Util function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Send message to WhatsApp
 */
async function sendWhatsAppMessage(
  phoneNumber: string,
  content: string,
  businessAccountId: string
): Promise<boolean> {
  try {
    // Call our WhatsApp send endpoint
    const sendUrl = new URL('/api/integrations/whatsapp/send', process.env.NEXT_PUBLIC_API_URL);
    
    const response = await fetch(sendUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phone_number: phoneNumber,
        message: content,
        business_account_id: businessAccountId,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error(`❌ Error al enviar mensaje a WhatsApp: ${JSON.stringify(errorData)}`);
      return false;
    }
    
    const data = await response.json();
    console.log(`✅ Mensaje enviado a WhatsApp: ${JSON.stringify(data)}`);
    return true;
  } catch (error) {
    console.error('❌ Error al enviar mensaje a WhatsApp:', error);
    return false;
  }
}

/**
 * Get conversation metadata including WhatsApp phone number
 */
async function getConversationMetadata(conversationId: string): Promise<{
  phoneNumber?: string;
  businessAccountId?: string;
  visitorId?: string;
  agentId?: string;
  siteId?: string;
} | null> {
  try {
    // Get conversation with visitor info
    const { data: conversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .select(`
        id,
        visitor_id,
        agent_id,
        site_id,
        custom_data,
        visitors:visitor_id (
          id,
          custom_data
        )
      `)
      .eq('id', conversationId)
      .single();
    
    if (convError) {
      console.error(`❌ Error al obtener conversación ${conversationId}:`, convError);
      return null;
    }
    
    if (!conversation) {
      console.error(`❌ No se encontró la conversación ${conversationId}`);
      return null;
    }
    
    // Extract WhatsApp phone number from custom data
    let phoneNumber: string | undefined;
    let businessAccountId: string | undefined;
    
    // Check conversation custom data first
    if (conversation.custom_data && typeof conversation.custom_data === 'object') {
      if (conversation.custom_data.whatsapp_phone) {
        phoneNumber = conversation.custom_data.whatsapp_phone;
      }
      
      if (conversation.custom_data.business_account_id) {
        businessAccountId = conversation.custom_data.business_account_id;
      }
    }
    
    // If not found, check visitor custom data
    if (!phoneNumber && conversation.visitors) {
      const visitor = conversation.visitors as any; // Type assertion to avoid TypeScript errors
      if (visitor.custom_data) {
        if (visitor.custom_data.whatsapp_phone) {
          phoneNumber = visitor.custom_data.whatsapp_phone;
        }
        
        if (visitor.custom_data.business_account_id) {
          businessAccountId = visitor.custom_data.business_account_id;
        }
      }
    }
    
    if (!phoneNumber) {
      console.warn(`⚠️ No se encontró número de teléfono de WhatsApp para la conversación ${conversationId}`);
    }
    
    return {
      phoneNumber,
      businessAccountId,
      visitorId: conversation.visitor_id,
      agentId: conversation.agent_id,
      siteId: conversation.site_id,
    };
  } catch (error) {
    console.error('❌ Error al obtener metadatos de conversación:', error);
    return null;
  }
}

/**
 * Process a message through the agent system
 */
async function processMessageWithAgent(
  message: string,
  visitorId: string,
  agentId: string,
  siteId: string,
  conversationId: string
): Promise<string | null> {
  try {
    // Create the command using CommandFactory
    const command = CommandFactory.createCommand({
      task: 'create message for whatsapp',
      userId: 'system', // Since this is automated, use system user
      agentId,
      site_id: siteId,
      description: 'Respond to a WhatsApp message from a user',
      targets: [
        {
          message: {
            content: "message example" // Will be filled by the agent
          }
        }
      ],
      // No need for tools for basic message response
      // Context includes the current message and conversation ID
      context: `WhatsApp message from user: ${message}\nConversation ID: ${conversationId}`,
      model: 'gpt-5-mini',
      modelType: 'openai'
    });
    
    // Submit the command for processing
    const commandId = await commandService.submitCommand(command);
    console.log(`📝 Comando creado con ID: ${commandId}`);
    
    // Wait for the command to complete (max 60 seconds)
    let attempts = 0;
    const maxAttempts = 100;
    
    while (attempts < maxAttempts) {
      attempts++;
      
      // Wait 1 second between checks
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Check command status
      const executedCommand = await commandService.getCommandById(commandId);
      
      if (!executedCommand) {
        console.log(`⚠️ No se pudo encontrar el comando ${commandId}`);
        break;
      }
      
      if (executedCommand.status === 'completed') {
        console.log(`✅ Comando ${commandId} completado`);
        
        // Extract the response from the agent
        if (executedCommand.results && Array.isArray(executedCommand.results)) {
          // Look for message content in results
          for (const result of executedCommand.results) {
            // Check different possible result structures
            if (result.message && result.message.content) {
              return result.message.content;
            } else if (result.content && typeof result.content === 'string') {
              return result.content;
            } else if (result.content && result.content.message && result.content.message.content) {
              return result.content.message.content;
            }
          }
        }
        
        console.warn(`⚠️ No se encontró respuesta en los resultados del comando ${commandId}`);
        break;
      } else if (executedCommand.status === 'failed') {
        console.error(`❌ Comando ${commandId} falló`);
        break;
      }
      
      console.log(`⏳ Esperando que se complete el comando ${commandId} (intento ${attempts}/${maxAttempts})`);
    }
    
    if (attempts >= maxAttempts) {
      console.error(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error al procesar mensaje con el agente:', error);
    return null;
  }
}

/**
 * Save agent response to the database and send it via WhatsApp
 */
async function saveAndSendAgentResponse(
  conversationId: string,
  visitorId: string,
  agentResponse: string,
  phoneNumber: string,
  businessAccountId?: string
): Promise<boolean> {
  try {
    // Save the message in the database
    const { data: savedMessage, error: msgError } = await supabaseAdmin
      .from('messages')
      .insert([
        {
          conversation_id: conversationId,
          content: agentResponse,
          role: 'assistant',
          custom_data: {
            source: 'whatsapp',
            whatsapp_phone: phoneNumber
          }
        }
      ])
      .select()
      .single();
    
    if (msgError) {
      console.error('❌ Error al guardar respuesta del agente:', msgError);
      return false;
    }
    
    console.log(`💾 Respuesta del agente guardada con ID: ${savedMessage.id}`);
    
    // Send the message via WhatsApp
    const sentToWhatsApp = await sendWhatsAppMessage(
      phoneNumber,
      agentResponse,
      businessAccountId || process.env.WHATSAPP_PHONE_NUMBER_ID || ''
    );
    
    if (!sentToWhatsApp) {
      console.error('❌ Error al enviar respuesta a WhatsApp');
      return false;
    }
    
    console.log(`📱 Respuesta enviada a WhatsApp para ${phoneNumber.substring(0, 5)}***`);
    return true;
  } catch (error) {
    console.error('❌ Error al guardar y enviar respuesta del agente:', error);
    return false;
  }
}

/**
 * POST handler for processing WhatsApp messages with agents
 */
export async function POST(request: NextRequest) {
  try {
    // Parse request
    const body = await request.json();
    const { conversation_id, message_id } = body;
    
    // Validate required parameters
    if (!conversation_id || !isValidUUID(conversation_id)) {
      return NextResponse.json({
        success: false,
        error: 'Missing or invalid conversation_id'
      }, { status: 400 });
    }
    
    if (!message_id || !isValidUUID(message_id)) {
      return NextResponse.json({
        success: false,
        error: 'Missing or invalid message_id'
      }, { status: 400 });
    }
    
    // Get the message content
    const { data: message, error: msgError } = await supabaseAdmin
      .from('messages')
      .select('id, content, conversation_id, visitor_id')
      .eq('id', message_id)
      .single();
    
    if (msgError || !message) {
      console.error('❌ Error al obtener mensaje:', msgError);
      return NextResponse.json({
        success: false,
        error: 'Message not found'
      }, { status: 404 });
    }
    
    // Get conversation metadata
    const metadata = await getConversationMetadata(conversation_id);
    
    if (!metadata || !metadata.phoneNumber) {
      return NextResponse.json({
        success: false,
        error: 'WhatsApp metadata not found for conversation'
      }, { status: 404 });
    }
    
    if (!metadata.agentId || !metadata.siteId) {
      return NextResponse.json({
        success: false,
        error: 'Agent or site ID not found for conversation'
      }, { status: 404 });
    }
    
    // Process the message with the agent
    const agentResponse = await processMessageWithAgent(
      message.content,
      metadata.visitorId || '',
      metadata.agentId,
      metadata.siteId,
      conversation_id
    );
    
    if (!agentResponse) {
      return NextResponse.json({
        success: false,
        error: 'Failed to generate agent response'
      }, { status: 500 });
    }
    
    // Save and send the agent response
    const sent = await saveAndSendAgentResponse(
      conversation_id,
      metadata.visitorId || '',
      agentResponse,
      metadata.phoneNumber,
      metadata.businessAccountId
    );
    
    if (!sent) {
      return NextResponse.json({
        success: false,
        error: 'Failed to send response via WhatsApp'
      }, { status: 500 });
    }
    
    // Return success
    return NextResponse.json({
      success: true,
      message: 'Agent response generated and sent via WhatsApp'
    }, { status: 200 });
    
  } catch (error) {
    console.error('❌ Error al procesar mensaje de WhatsApp con agente:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal server error'
    }, { status: 500 });
  }
} 